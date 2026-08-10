// Applique les highlights dans le chat Twitch (live et VOD).
//
// Principe : on ne génère plus de CSS par utilisateur. Un MutationObserver pose
// un attribut + une variable CSS sur chaque ligne au moment où elle apparaît,
// et la feuille styles.css contient une règle unique. Le coût par message est
// donc constant, quelle que soit la taille des listes.

(() => {
    "use strict";

    const LINE_SELECTOR = ".chat-line__message, .vod-message";
    const BADGE_IMG_SELECTOR = 'img[src*="/badges/v1/"]';
    const HIGHLIGHT_ATTR = "data-tch-highlight";
    const COLOR_VAR = "--tch-highlight-color";

    // Twitch renomme régulièrement ses classes ; on essaie plusieurs pistes et
    // on retombe sur <body> si aucune ne répond.
    const CONTAINER_SELECTORS = [
        ".chat-scrollable-area__message-container",
        '[data-test-selector="chat-scrollable-area__message-container"]',
        '[data-a-target="video-chat-message-list"]',
        ".video-chat__message-list-wrapper ul",
    ];

    // Premiers segments d'URL qui ne désignent pas une chaîne.
    const RESERVED_PATHS = new Set([
        "directory", "videos", "video", "settings", "subscriptions", "wallet",
        "drops", "inventory", "store", "prime", "downloads", "jobs", "turbo",
        "search", "friends", "messages", "payments", "following", "collections",
        "team", "event", "clips", "popout", "moderator", "u", "p", "legal",
        "broadcast", "dashboard", "products", "communities", "bits",
    ]);

    // Repli quand l'URL ne porte pas le nom de la chaîne (pages de VOD).
    const CHANNEL_LINK_SELECTORS = [
        'a[data-a-target="watch-mode-channel-link"]',
        'a[data-a-target="video-info-channel-name"]',
        'a[data-a-target="player-info-channel-name"]',
        'a[data-test-selector="ChannelLink"]',
        '[data-a-target="user-channel-header-item"] a[href^="/"]',
    ];

    const WRITE_DEBOUNCE_MS = 1500;

    // --- État en mémoire -----------------------------------------------------
    // Tout est ici plutôt que relu depuis chrome.storage à chaque interaction :
    // c'était le coût dominant de la v1.

    let settings = { ...TCH.DEFAULT_SETTINGS };
    let badgeIndex = {};
    let badgeByKey = new Map();
    let userByLogin = new Map();

    let channel = TCH.SCOPE_UNKNOWN;
    let knownPath = "";
    let container = null;
    let lineObserver = null;
    let settingsDirty = false;
    let indexDirty = false;
    let writeTimer = null;

    function rebuildLookups() {
        badgeByKey = new Map(settings.badges.map((badge) => [badge.key, badge]));
        userByLogin = new Map(settings.users.map((user) => [user.login, user]));
    }

    const hoverButtonAllowed = () => settings.enabled && settings.showHoverButton;

    // --- Chaîne courante -----------------------------------------------------

    function channelFromDom() {
        for (const selector of CHANNEL_LINK_SELECTORS) {
            const href = document.querySelector(selector)?.getAttribute("href");
            const name = href?.split("/").filter(Boolean)[0];
            if (name && !RESERVED_PATHS.has(name.toLowerCase())) {
                return name.toLowerCase();
            }
        }
        return null;
    }

    function detectChannel() {
        const parts = location.pathname.split("/").filter(Boolean);
        const head = parts[0]?.toLowerCase();

        if (location.hostname === "dashboard.twitch.tv") {
            return head === "u" && parts[1] ? parts[1].toLowerCase() : channelFromDom();
        }
        // /popout/<chaîne>/chat, /moderator/<chaîne>
        if ((head === "popout" || head === "moderator") && parts[1]) {
            return parts[1].toLowerCase();
        }
        // /<chaîne>
        if (head && !RESERVED_PATHS.has(head)) return head;

        // Pages de VOD et de clips : le nom n'est pas dans l'URL.
        return channelFromDom();
    }

    // Renvoie true si la chaîne a changé.
    function refreshChannel() {
        knownPath = location.pathname;
        const found = detectChannel() || TCH.SCOPE_UNKNOWN;
        if (found === channel) return false;
        channel = found;
        return true;
    }

    // --- Écritures différées -------------------------------------------------
    // La découverte des badges provoque des écritures ; on les regroupe pour ne
    // pas marteler le storage (et son quota, côté sync).

    function queueWrite({ settings: dirtySettings, index: dirtyIndex }) {
        if (dirtySettings) settingsDirty = true;
        if (dirtyIndex) indexDirty = true;
        if (writeTimer) return;
        writeTimer = setTimeout(flushWrites, WRITE_DEBOUNCE_MS);
    }

    function flushWrites() {
        writeTimer = null;
        if (settingsDirty) {
            settingsDirty = false;
            TCH.saveSettings(settings);
        }
        if (indexDirty) {
            indexDirty = false;
            TCH.saveBadgeIndex(badgeIndex);
        }
    }

    // --- Badges --------------------------------------------------------------

    function createBadge(scope, label) {
        const entry = {
            key: TCH.makeKey(scope, label),
            scope,
            label,
            color: TCH.pickColor(settings.badges.length),
            // Inactif par défaut : découvrir un badge ne doit pas colorer le
            // chat sans que l'utilisateur l'ait demandé.
            mode: TCH.MODE.OFF,
        };
        settings.badges.push(entry);
        badgeByKey.set(entry.key, entry);
        queueWrite({ settings: true });
        return entry;
    }

    // Déplace un badge vers une autre portée. Si une entrée existe déjà à
    // destination, les deux fusionnent : on garde la cible et on réoriente les
    // imageIds de la source.
    function moveScope(entry, scope) {
        const targetKey = TCH.makeKey(scope, entry.label);
        const existing = badgeByKey.get(targetKey);
        const previousKey = entry.key;
        let winner;

        if (existing && existing !== entry) {
            settings.badges = settings.badges.filter((badge) => badge !== entry);
            badgeByKey.delete(previousKey);
            // Un réglage explicite d'un côté ou de l'autre est conservé ; en
            // cas de désaccord, celui de la destination l'emporte.
            if (existing.mode === TCH.MODE.OFF) existing.mode = entry.mode;
            winner = existing;
        } else {
            badgeByKey.delete(previousKey);
            entry.key = targetKey;
            entry.scope = scope;
            badgeByKey.set(targetKey, entry);
            winner = entry;
        }

        for (const [imageId, ref] of Object.entries(badgeIndex)) {
            if (ref.key === previousKey) {
                badgeIndex[imageId] = { key: winner.key, scope: winner.scope };
            }
        }

        queueWrite({ settings: true, index: true });
        return winner;
    }

    // Résout un <img> de badge vers son entrée de réglages, en enregistrant le
    // badge s'il est inconnu. La correspondance passe par l'imageId (stable et
    // indépendant de la langue), pas par l'`alt`.
    function resolveBadge(img) {
        const imageId = TCH.extractBadgeId(img.getAttribute("src"));
        if (!imageId) return null;

        const label = (img.getAttribute("alt") || "").trim();
        const ref = badgeIndex[imageId];
        let entry = ref ? badgeByKey.get(ref.key) : null;

        if (entry) {
            // L'utilisateur a changé la langue de Twitch : on suit le libellé
            // sans casser la correspondance ni créer de doublon.
            if (label && entry.label !== label) {
                entry.label = label;
                queueWrite({ settings: true });
            }

            if (TCH.isChannelScope(channel) && entry.scope !== channel) {
                if (entry.scope === TCH.SCOPE_UNKNOWN) {
                    // Badge vu d'abord sur une page sans chaîne identifiable :
                    // on le rattache maintenant qu'on la connaît.
                    entry = moveScope(entry, channel);
                } else if (entry.scope !== TCH.SCOPE_GLOBAL) {
                    // Le même imageId sur deux chaînes : c'est un badge Twitch
                    // commun, pas un badge de chaîne.
                    entry = moveScope(entry, TCH.SCOPE_GLOBAL);
                }
            }

            if (ref.key !== entry.key) {
                badgeIndex[imageId] = { key: entry.key, scope: entry.scope };
                queueWrite({ index: true });
            }
            return entry;
        }

        if (!TCH.normalizeLabel(label)) return null;

        const scope = TCH.isChannelScope(channel) ? channel : TCH.SCOPE_UNKNOWN;
        // Un badge déjà connu comme commun à tout Twitch le reste, même vu pour
        // la première fois sur cette chaîne : sans ça, des réglages migrés
        // depuis la v1 seraient dupliqués en badge de chaîne à la première
        // lecture, et leur couleur perdue.
        entry =
            badgeByKey.get(TCH.makeKey(TCH.SCOPE_GLOBAL, label)) ||
            badgeByKey.get(TCH.makeKey(scope, label)) ||
            createBadge(scope, label);
        badgeIndex[imageId] = { key: entry.key, scope: entry.scope };
        queueWrite({ index: true });
        return entry;
    }

    // Couleur dictée par les badges de la ligne. On parcourt tout même après
    // avoir trouvé une couleur : pour alimenter le registre, et parce qu'un
    // badge exclu rencontré plus loin annule la coloration.
    function badgeColorFor(line) {
        let color = null;
        let excluded = false;
        for (const img of line.querySelectorAll(BADGE_IMG_SELECTOR)) {
            const entry = resolveBadge(img);
            if (!entry) continue;
            if (entry.mode === TCH.MODE.BLACK) excluded = true;
            else if (!color && entry.mode === TCH.MODE.WHITE) color = entry.color;
        }
        return excluded ? null : color;
    }

    // --- Lignes de chat ------------------------------------------------------

    // En live le login est sur la ligne elle-même ; en VOD il est porté par un
    // descendant.
    function getLogin(line) {
        return (
            line.getAttribute("data-a-user") ||
            line.querySelector("[data-a-user]")?.getAttribute("data-a-user") ||
            null
        );
    }

    // Une règle nominative l'emporte toujours sur une règle de badge : un
    // utilisateur explicitement mis en avant le reste même s'il porte un badge
    // exclu, et inversement.
    function colorFor(line) {
        const user = userByLogin.get(getLogin(line));
        if (user?.mode === TCH.MODE.BLACK) return null;
        if (user?.mode === TCH.MODE.WHITE) return user.color || settings.defaultColor;
        return badgeColorFor(line);
    }

    function processLine(line) {
        const color = settings.enabled ? colorFor(line) : null;
        if (color) {
            line.style.setProperty(COLOR_VAR, color);
            line.setAttribute(HIGHLIGHT_ATTR, "");
        } else {
            line.style.removeProperty(COLOR_VAR);
            line.removeAttribute(HIGHLIGHT_ATTR);
        }
    }

    function processTree(root) {
        if (root.nodeType !== Node.ELEMENT_NODE) return;
        if (root.matches(LINE_SELECTOR)) {
            processLine(root);
            return;
        }
        for (const line of root.querySelectorAll(LINE_SELECTOR)) {
            processLine(line);
        }
    }

    // Relecture complète : uniquement sur changement de réglages, jamais dans le
    // chemin chaud d'arrivée des messages.
    function rescanAll() {
        for (const line of document.querySelectorAll(LINE_SELECTOR)) {
            processLine(line);
        }
        if (hostLine) refreshButton();
    }

    // --- Bouton d'action au survol -------------------------------------------
    // Un seul élément réutilisé, déplacé de ligne en ligne. `insertBefore` le
    // détache automatiquement de son parent précédent, donc aucune allocation
    // ni balayage du document par survol (la v1 faisait les deux).

    let actionButton = null;
    let hostLine = null;

    function ensureButton() {
        if (actionButton) return actionButton;
        actionButton = document.createElement("button");
        actionButton.id = "tch-action-button";
        actionButton.type = "button";
        actionButton.addEventListener("click", onActionClick);
        return actionButton;
    }

    function detachButton() {
        if (!hostLine) return;
        hostLine.classList.remove("tch-hover-host");
        actionButton?.remove();
        hostLine = null;
    }

    // Déjà réglé sur cet utilisateur : le bouton le retire. Sinon il l'ajoute,
    // en exclusion si la ligne est colorée par un badge (le geste utile est
    // alors d'écarter cet utilisateur-là), en mise en avant dans les autres cas.
    function refreshButton() {
        if (!hostLine || !actionButton) return;
        const login = getLogin(hostLine);
        if (!login) return detachButton();

        const existing = userByLogin.get(login);
        const mode = existing
            ? TCH.MODE.OFF
            : badgeColorFor(hostLine)
            ? TCH.MODE.BLACK
            : TCH.MODE.WHITE;

        actionButton.dataset.mode = mode;
        actionButton.dataset.login = login;
        actionButton.textContent = mode === TCH.MODE.OFF ? "−" : "+";
        actionButton.title =
            mode === TCH.MODE.OFF
                ? `Remove ${login} from the list`
                : `${mode === TCH.MODE.BLACK ? "Exclude" : "Highlight"} ${login}`;
        actionButton.classList.toggle("tch-action-remove", mode === TCH.MODE.OFF);
        actionButton.classList.toggle("tch-action-exclude", mode === TCH.MODE.BLACK);
    }

    function attachButton(line) {
        if (hostLine === line) return;
        detachButton();
        if (!getLogin(line)) return;

        hostLine = line;
        const button = ensureButton();
        refreshButton();
        line.classList.add("tch-hover-host");
        line.insertBefore(button, line.firstChild);
    }

    function onActionClick(event) {
        event.preventDefault();
        event.stopPropagation();

        const { mode, login } = actionButton.dataset;
        if (!mode || !login) return;

        settings.users = settings.users.filter((user) => user.login !== login);
        if (mode !== TCH.MODE.OFF) {
            settings.users = [...settings.users, TCH.makeUser(login, mode)];
        }

        rebuildLookups();
        TCH.saveSettings(settings);
        rescanAll();
    }

    function onMouseOver(event) {
        if (!hoverButtonAllowed()) return;
        const line = event.target.closest?.(LINE_SELECTOR);
        // Survol du chat en dehors de toute ligne : le bouton n'a plus d'hôte
        // pertinent, il disparaît au lieu de rester collé à la dernière ligne.
        if (line) attachButton(line);
        else detachButton();
    }

    // --- Observation du chat -------------------------------------------------

    function onMutations(records) {
        for (const record of records) {
            for (const node of record.addedNodes) processTree(node);
        }
    }

    function findContainer() {
        for (const selector of CONTAINER_SELECTORS) {
            const found = document.querySelector(selector);
            if (found) return found;
        }
        return null;
    }

    // Le conteneur est recréé à chaque changement de chaîne (navigation SPA,
    // sans rechargement de page) : on se réaccroche quand il disparaît.
    function attachToChat() {
        const channelChanged = refreshChannel();
        if (container && container.isConnected) {
            // Même conteneur mais autre chaîne (VOD chargée après coup) : la
            // portée des badges change, donc les couleurs aussi.
            if (channelChanged) rescanAll();
            return;
        }

        const found = findContainer() || document.body;
        if (container === found) return;

        lineObserver?.disconnect();
        container?.removeEventListener("mouseover", onMouseOver);
        container?.removeEventListener("mouseleave", detachButton);
        detachButton();

        container = found;
        container.addEventListener("mouseover", onMouseOver);
        // La souris quitte le chat sans passer par une autre ligne : sans ça le
        // bouton restait affiché sur la dernière ligne survolée.
        container.addEventListener("mouseleave", detachButton);
        lineObserver = new MutationObserver(onMutations);
        lineObserver.observe(container, { childList: true, subtree: true });
        rescanAll();
    }

    // Surveille l'apparition / le remplacement du conteneur de chat, et le
    // changement de chaîne. Le traitement se réduit à une comparaison de chaîne
    // de caractères tant que rien ne bouge.
    function watchForChat() {
        let scheduled = false;
        const mountObserver = new MutationObserver(() => {
            const settled =
                location.pathname === knownPath &&
                container &&
                container !== document.body &&
                container.isConnected;
            if (settled || scheduled) return;

            scheduled = true;
            requestAnimationFrame(() => {
                scheduled = false;
                attachToChat();
            });
        });
        mountObserver.observe(document.body, { childList: true, subtree: true });
    }

    // --- Synchronisation des réglages ---------------------------------------
    // Remplace l'aller-retour popup -> service worker -> executeScript de la v1.
    // Tous les onglets ouverts se mettent à jour, y compris en arrière-plan.

    function onStorageChanged(changes, area) {
        if (area === "sync" && changes[TCH.SETTINGS_KEY]) {
            settings = { ...TCH.DEFAULT_SETTINGS, ...changes[TCH.SETTINGS_KEY].newValue };
            settings.users = settings.users || [];
            settings.badges = settings.badges || [];
            rebuildLookups();
            if (!hoverButtonAllowed()) detachButton();
            rescanAll();
        }
        if (area === "local" && changes[TCH.INDEX_KEY]) {
            badgeIndex = TCH.readIndex(changes[TCH.INDEX_KEY].newValue);
        }
    }

    // Le popup demande quelle chaîne est affichée, pour ne lister que ses
    // badges. Passer par un message plutôt que par le storage garantit qu'il
    // interroge bien l'onglet qu'il recouvre.
    function onMessage(message, sender, sendResponse) {
        if (message?.type === "tch:getChannel") {
            sendResponse({ channel });
            return true;
        }
        return false;
    }

    async function init() {
        const state = await TCH.loadState();
        settings = state.settings;
        badgeIndex = state.badgeIndex;
        rebuildLookups();

        chrome.storage.onChanged.addListener(onStorageChanged);
        chrome.runtime.onMessage.addListener(onMessage);
        window.addEventListener("pagehide", flushWrites);

        attachToChat();
        watchForChat();
    }

    init();
})();
