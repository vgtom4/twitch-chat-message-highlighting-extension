// Applique les highlights dans le chat Twitch (live et VOD).
//
// Principe : un MutationObserver pose un attribut + une variable CSS sur chaque
// ligne au moment où elle apparaît, et la feuille styles.css contient une règle
// unique. Le coût par message est donc constant, quelle que soit la taille des
// listes.

(() => {
    "use strict";

    const LINE_SELECTOR = ".chat-line__message, .vod-message";
    const BADGE_IMG_SELECTOR = 'img[src*="/badges/v1/"]';
    const HIGHLIGHT_ATTR = "data-tch-highlight";
    // Une règle retient la ligne sans la peindre.
    const KEEP_ATTR = "data-tch-keep";
    const FILTER_ATTR = "data-tch-filter";
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

    // Verdict d'une ligne reconnue mais non peinte.
    const KEEP = "keep";
    const colorOf = (verdict) => (verdict === KEEP ? null : verdict);

    const WRITE_DEBOUNCE_MS = 1500;

    // Recherche de la chaîne d'une page qui ne la porte pas dans son URL. Passé
    // ce délai, la page n'en a probablement pas (accueil, /directory...).
    const CHANNEL_SEARCH_MS = 20000;
    const CHANNEL_RETRY_MS = 500;

    // --- État en mémoire -----------------------------------------------------
    // Tout est ici plutôt que relu depuis chrome.storage à chaque interaction,
    // qui serait le coût dominant.

    let settings = { ...TCH.DEFAULT_SETTINGS };
    let badgeByImageId = new Map();
    let badgeByKey = new Map();
    let userByLogin = new Map();

    // Tous les badges croisés dans ce chat depuis le début de la session, y
    // compris ceux qui ont une règle : la retirer les repropose aussitôt. Rien
    // n'est enregistré avant que le popup en choisisse un.
    const seenBadges = new Map(); // imageId -> { imageId, label, scope }

    let channel = TCH.SCOPE_UNKNOWN;
    let knownPath = "";
    let channelDeadline = 0;
    let channelTimer = null;
    let container = null;
    let lineObserver = null;
    let settingsDirty = false;
    let writeTimer = null;

    function rebuildLookups() {
        badgeByKey = new Map(settings.badges.map((badge) => [badge.key, badge]));
        userByLogin = new Map();
        for (const user of settings.users) userByLogin.set(user.login, user);

        // Une règle porte tous les imageIds sous lesquels on l'a reconnue.
        badgeByImageId = new Map();
        for (const badge of settings.badges) {
            for (const imageId of badge.imageIds || []) {
                badgeByImageId.set(imageId, badge);
            }
        }
    }

    const hoverButtonAllowed = () => settings.enabled && settings.showHoverButton;

    // Le masquage est purement CSS : le filtre est posé sur la racine.
    function applyDisplayMode() {
        const filter = settings.enabled ? settings.chatFilter : TCH.FILTER.ALL;
        if (filter === TCH.FILTER.ALL) {
            document.documentElement.removeAttribute(FILTER_ATTR);
        } else {
            document.documentElement.setAttribute(FILTER_ATTR, filter);
        }
    }

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

    // Sur une VOD, le nom n'arrive qu'avec le player, parfois plusieurs
    // secondes après le chat. On le cherche au rythme d'un minuteur, pas des
    // mutations : le chat en produit trop pour servir de repère.
    function searchChannel() {
        if (channelTimer || channel !== TCH.SCOPE_UNKNOWN) return;
        if (Date.now() > channelDeadline) return;

        channelTimer = setTimeout(() => {
            channelTimer = null;
            // `refreshChannel` se relance tant qu'il ne trouve pas.
            if (refreshChannel()) rescanAll();
        }, CHANNEL_RETRY_MS);
    }

    // Renvoie true si la chaîne a changé.
    function refreshChannel() {
        if (location.pathname !== knownPath) {
            knownPath = location.pathname;
            channelDeadline = Date.now() + CHANNEL_SEARCH_MS;
        }

        const changed = applyChannel(detectChannel() || TCH.SCOPE_UNKNOWN);
        searchChannel();
        return changed;
    }

    function applyChannel(found) {
        if (found === channel) return false;

        const wasUnknown = channel === TCH.SCOPE_UNKNOWN;
        channel = found;

        if (wasUnknown && TCH.isChannelScope(found)) {
            // Même page, chaîne identifiée après coup (VOD, chargement tardif) :
            // les badges déjà croisés sont les bons, on les rattache.
            for (const entry of seenBadges.values()) entry.scope = found;
        } else {
            // Changement de chaîne : les badges de la précédente n'ont plus à
            // être proposés ici.
            seenBadges.clear();
        }
        return true;
    }

    // --- Écritures différées -------------------------------------------------
    // Il ne reste que l'entretien des règles existantes (libellé qui suit la
    // langue, imageId rattaché, changement de portée) : on les regroupe pour ne
    // pas marteler le storage et son quota.

    function queueWrite() {
        settingsDirty = true;
        if (writeTimer) return;
        writeTimer = setTimeout(flushWrites, WRITE_DEBOUNCE_MS);
    }

    function flushWrites() {
        writeTimer = null;
        if (!settingsDirty) return;
        settingsDirty = false;
        TCH.saveSettings(settings);
    }

    // --- Badges --------------------------------------------------------------

    // Déplace une règle vers une autre portée. Si une règle existe déjà à
    // destination sous le même libellé, les deux fusionnent.
    function moveScope(entry, scope) {
        const targetKey = TCH.makeKey(scope, entry.label);
        const existing = badgeByKey.get(targetKey);

        if (existing && existing !== entry) {
            settings.badges = settings.badges.filter((badge) => badge !== entry);
            // Un réglage explicite d'un côté ou de l'autre est conservé ; en
            // cas de désaccord, celui de la destination l'emporte.
            if (existing.mode === TCH.MODE.OFF) existing.mode = entry.mode;
            existing.imageIds = [
                ...new Set([...existing.imageIds, ...entry.imageIds]),
            ];
            rebuildLookups();
            queueWrite();
            return existing;
        }

        entry.key = targetKey;
        entry.scope = scope;
        rebuildLookups();
        queueWrite();
        return entry;
    }

    // Rattache un imageId à une règle existante. Sert aux règles issues d'une
    // migration, qui connaissent leur libellé mais pas encore leurs imageIds.
    function attachImageId(entry, imageId) {
        if (entry.imageIds.includes(imageId)) return;
        entry.imageIds.push(imageId);
        badgeByImageId.set(imageId, entry);
        queueWrite();
    }

    // Résout un <img> de badge vers sa règle, s'il en a une. Sinon le badge est
    // seulement mémorisé pour la session, à proposer dans le popup : rien n'est
    // enregistré tant que l'utilisateur ne l'a pas choisi.
    function resolveBadge(img) {
        const imageId = TCH.extractBadgeId(img.getAttribute("src"));
        // Badges de la liste d'exclusion (prédictions...) : ni proposés, ni pris
        // en compte pour la couleur.
        if (!imageId || TCH.isIgnoredBadge(imageId)) return null;

        const label = (img.getAttribute("alt") || "").trim();
        let entry = badgeByImageId.get(imageId);

        // Règle sans imageId connu (migration) : on la reconnaît par son
        // libellé, une seule fois, puis l'imageId prend le relais.
        if (!entry && TCH.normalizeLabel(label)) {
            const scope = TCH.isChannelScope(channel) ? channel : TCH.SCOPE_UNKNOWN;
            entry =
                badgeByKey.get(TCH.makeKey(TCH.SCOPE_GLOBAL, label)) ||
                badgeByKey.get(TCH.makeKey(TCH.SCOPE_EVENT, label)) ||
                badgeByKey.get(TCH.makeKey(scope, label));
            if (entry) attachImageId(entry, imageId);
        }

        if (!entry) {
            if (TCH.normalizeLabel(label)) rememberSeen(imageId, label);
            return null;
        }

        // L'utilisateur a changé la langue de Twitch : on suit le libellé sans
        // casser la correspondance, qui repose sur l'imageId.
        if (label && entry.label !== label) {
            entry.label = label;
            queueWrite();
        }

        if (TCH.isChannelScope(channel) && entry.scope !== channel) {
            if (entry.scope === TCH.SCOPE_UNKNOWN) {
                // Règle créée sur une page sans chaîne identifiable : on la
                // rattache maintenant qu'on la connaît.
                entry = moveScope(entry, channel);
                entry.origin = entry.scope;
            } else if (TCH.isChannelScope(entry.scope)) {
                // Le même imageId sur deux chaînes : ce n'est pas un badge
                // propre à un streamer. Il part en Event, jamais en Global —
                // ce dernier reste un classement manuel.
                entry = moveScope(entry, TCH.SCOPE_EVENT);
            }
            // Déjà en Global ou en Event : on n'y touche plus.
        }

        return entry;
    }

    function rememberSeen(imageId, label) {
        const known = seenBadges.get(imageId);
        // Le libellé peut changer de langue en cours de session.
        if (known) {
            known.label = label;
            return;
        }
        seenBadges.set(imageId, {
            imageId,
            label,
            scope: TCH.isChannelScope(channel) ? channel : TCH.SCOPE_UNKNOWN,
        });
    }

    // Verdict dicté par les badges de la ligne : une couleur, KEEP si une règle
    // la reconnaît sans la peindre, null sinon. On parcourt tout même après
    // avoir trouvé une couleur : pour alimenter le registre, et parce qu'un
    // badge exclu rencontré plus loin annule la coloration.
    function badgeVerdictFor(line) {
        let color = null;
        let kept = false;
        let excluded = false;
        for (const img of line.querySelectorAll(BADGE_IMG_SELECTOR)) {
            const entry = resolveBadge(img);
            if (!entry) continue;
            if (entry.mode === TCH.MODE.BLACK) excluded = true;
            else if (entry.mode === TCH.MODE.WHITE) color = color || entry.color;
            else kept = true;
        }
        if (excluded) return null;
        return color || (kept ? KEEP : null);
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
    function verdictFor(line) {
        const user = userByLogin.get(getLogin(line));
        if (user?.mode === TCH.MODE.BLACK) return null;
        if (user?.mode === TCH.MODE.WHITE) return user.color || settings.defaultColor;
        return badgeVerdictFor(line) || (user ? KEEP : null);
    }

    function processLine(line) {
        const verdict = settings.enabled ? verdictFor(line) : null;
        const color = colorOf(verdict);

        if (color) {
            line.style.setProperty(COLOR_VAR, color);
            line.setAttribute(HIGHLIGHT_ATTR, "");
        } else {
            line.style.removeProperty(COLOR_VAR);
            line.removeAttribute(HIGHLIGHT_ATTR);
        }
        line.toggleAttribute(KEEP_ATTR, verdict === KEEP);
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
    // ni balayage du document par survol.

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
            : colorOf(badgeVerdictFor(hostLine))
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
        // La souris peut quitter le chat sans passer par une autre ligne : le
        // bouton doit alors être retiré de la dernière ligne survolée.
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
            // Pendant la recherche, une mutation est une occasion de retenter.
            const searchingChannel =
                channel === TCH.SCOPE_UNKNOWN && Date.now() <= channelDeadline;

            const settled =
                !searchingChannel &&
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
    // Le popup écrit dans le storage, les onglets suivent : tous se mettent à
    // jour, y compris en arrière-plan.

    function onStorageChanged(changes, area) {
        if (area === "sync" && changes[TCH.SETTINGS_KEY]) {
            settings = { ...TCH.DEFAULT_SETTINGS, ...changes[TCH.SETTINGS_KEY].newValue };
            settings.users = settings.users || [];
            settings.badges = settings.badges || [];
            rebuildLookups();
            if (!hoverButtonAllowed()) detachButton();
            applyDisplayMode();
            rescanAll();
        }
    }

    // Le popup demande la chaîne affichée et les badges croisés dans ce chat.
    // Passer par un message plutôt que par le storage garantit qu'il interroge
    // bien l'onglet qu'il recouvre, et évite d'enregistrer quoi que ce soit.
    function onMessage(message, sender, sendResponse) {
        if (message?.type === "tch:getState") {
            // Seuls les badges sans règle sont à proposer.
            const seen = [...seenBadges.values()].filter(
                (entry) => !badgeByImageId.has(entry.imageId)
            );
            sendResponse({ channel, seen });
            return true;
        }
        return false;
    }

    async function init() {
        const state = await TCH.loadState();
        settings = state.settings;
        rebuildLookups();
        applyDisplayMode();

        chrome.storage.onChanged.addListener(onStorageChanged);
        chrome.runtime.onMessage.addListener(onMessage);
        window.addEventListener("pagehide", flushWrites);

        attachToChat();
        watchForChat();
    }

    init();
})();
