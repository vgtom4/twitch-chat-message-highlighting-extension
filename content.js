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

    const WRITE_DEBOUNCE_MS = 1500;

    // --- État en mémoire -----------------------------------------------------
    // Tout est ici plutôt que relu depuis chrome.storage à chaque interaction :
    // c'était le coût dominant de la v1.

    let settings = { ...TCH.DEFAULT_SETTINGS };
    let badgeIndex = {};
    let badgeByKey = new Map();
    let whiteSet = new Set();
    let blackSet = new Set();

    let container = null;
    let lineObserver = null;
    let settingsDirty = false;
    let indexDirty = false;
    let writeTimer = null;

    function rebuildLookups() {
        badgeByKey = new Map(settings.badges.map((badge) => [badge.key, badge]));
        whiteSet = new Set(settings.whitelisted);
        blackSet = new Set(settings.blacklisted);
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

    // Résout un <img> de badge vers son entrée de réglages, en enregistrant le
    // badge s'il est inconnu. La correspondance passe par l'imageId (stable et
    // indépendant de la langue), pas par l'`alt`.
    function resolveBadge(img) {
        const imageId = TCH.extractBadgeId(img.getAttribute("src"));
        if (!imageId) return null;

        const label = (img.getAttribute("alt") || "").trim();
        const knownKey = badgeIndex[imageId];

        if (knownKey) {
            const entry = badgeByKey.get(knownKey);
            // L'utilisateur a changé la langue de Twitch : on suit le libellé
            // sans casser la correspondance ni créer de doublon.
            if (entry && label && entry.label !== label) {
                entry.label = label;
                queueWrite({ settings: true });
            }
            return entry || null;
        }

        const key = TCH.normalizeLabel(label);
        if (!key) return null;

        let entry = badgeByKey.get(key);
        if (!entry) {
            entry = {
                key,
                label,
                color: TCH.pickColor(settings.badges.length),
                // Désactivé par défaut : découvrir un badge ne doit pas colorer
                // le chat sans que l'utilisateur l'ait demandé.
                isEnabled: false,
            };
            settings.badges.push(entry);
            badgeByKey.set(key, entry);
            queueWrite({ settings: true });
        } else if (label && entry.label !== label) {
            entry.label = label;
            queueWrite({ settings: true });
        }

        badgeIndex[imageId] = entry.key;
        queueWrite({ index: true });
        return entry;
    }

    // Couleur du premier badge actif de la ligne. On parcourt tous les badges
    // même après avoir trouvé la couleur, pour alimenter le registre.
    function badgeColorFor(line) {
        let color = null;
        for (const img of line.querySelectorAll(BADGE_IMG_SELECTOR)) {
            const entry = resolveBadge(img);
            if (!color && entry && entry.isEnabled) color = entry.color;
        }
        return color;
    }

    function hasActiveBadge(line) {
        for (const img of line.querySelectorAll(BADGE_IMG_SELECTOR)) {
            const entry = resolveBadge(img);
            if (entry && entry.isEnabled) return true;
        }
        return false;
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

    function colorFor(line) {
        const login = getLogin(line);
        if (login) {
            if (blackSet.has(login)) return null;
            if (whiteSet.has(login)) return settings.whitelistColor;
        }
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

    // Sur une ligne déjà colorée par un badge, l'action utile est d'exclure
    // l'utilisateur (blacklist) ; sinon c'est de l'ajouter (whitelist).
    function refreshButton() {
        if (!hostLine || !actionButton) return;
        const login = getLogin(hostLine);
        if (!login) return detachButton();

        const list = hasActiveBadge(hostLine) ? "blacklisted" : "whitelisted";
        const listed = settings[list].includes(login);

        actionButton.dataset.list = list;
        actionButton.dataset.login = login;
        actionButton.textContent = listed ? "−" : "+";
        actionButton.title = `${listed ? "Remove from" : "Add to"} ${
            list === "blacklisted" ? "blacklist" : "whitelist"
        } (${login})`;
        actionButton.classList.toggle("tch-action-remove", listed);
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

        const { list, login } = actionButton.dataset;
        if (!list || !login) return;

        if (settings[list].includes(login)) {
            settings[list] = settings[list].filter((user) => user !== login);
        } else {
            // Les deux listes sont exclusives.
            settings.whitelisted = settings.whitelisted.filter((u) => u !== login);
            settings.blacklisted = settings.blacklisted.filter((u) => u !== login);
            settings[list] = [...settings[list], login];
        }

        rebuildLookups();
        TCH.saveSettings(settings);
        rescanAll();
    }

    function onMouseOver(event) {
        const line = event.target.closest?.(LINE_SELECTOR);
        if (line) attachButton(line);
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
        if (container && container.isConnected) return;

        const found = findContainer() || document.body;
        if (container === found) return;

        lineObserver?.disconnect();
        container?.removeEventListener("mouseover", onMouseOver);
        detachButton();

        container = found;
        container.addEventListener("mouseover", onMouseOver);
        lineObserver = new MutationObserver(onMutations);
        lineObserver.observe(container, { childList: true, subtree: true });
        rescanAll();
    }

    // Surveille l'apparition / le remplacement du conteneur de chat. Le
    // traitement est réduit à un test de rattachement, groupé par frame.
    function watchForChat() {
        let scheduled = false;
        const mountObserver = new MutationObserver(() => {
            if (container && container !== document.body && container.isConnected) {
                return;
            }
            if (scheduled) return;
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
            settings.whitelisted = settings.whitelisted || [];
            settings.blacklisted = settings.blacklisted || [];
            settings.badges = settings.badges || [];
            rebuildLookups();
            rescanAll();
        }
        if (area === "local" && changes[TCH.INDEX_KEY]) {
            badgeIndex = changes[TCH.INDEX_KEY].newValue || {};
        }
    }

    async function init() {
        const state = await TCH.loadState();
        settings = state.settings;
        badgeIndex = state.badgeIndex;
        rebuildLookups();

        chrome.storage.onChanged.addListener(onStorageChanged);
        window.addEventListener("pagehide", flushWrites);

        attachToChat();
        watchForChat();
    }

    init();
})();
