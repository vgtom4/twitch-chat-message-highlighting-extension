// Le popup ne fait qu'écrire dans chrome.storage : les onglets Twitch ouverts
// réagissent d'eux-mêmes via chrome.storage.onChanged. Plus de service worker
// ni d'injection de script à la demande.

(() => {
    "use strict";

    const els = {
        enabledToggle: document.getElementById("enabledToggle"),
        newUsername: document.getElementById("newUsername"),
        highlightType: document.getElementById("highlightType"),
        addUserButton: document.getElementById("addUserButton"),
        newUsernameError: document.getElementById("newUsernameError"),
        whitelistColor: document.getElementById("whitelistColor"),
        channelBadges: document.getElementById("channelBadges"),
        channelBadgesTitle: document.getElementById("channelBadgesTitle"),
        channelBadgesHint: document.getElementById("channelBadgesHint"),
        globalBadges: document.getElementById("globalBadges"),
        globalBadgesCount: document.getElementById("globalBadgesCount"),
        globalBadgesHint: document.getElementById("globalBadgesHint"),
        otherBadges: document.getElementById("otherBadges"),
        otherBadgesCount: document.getElementById("otherBadgesCount"),
        otherBadgesDetails: document.getElementById("otherBadgesDetails"),
        whitelistDetails: document.getElementById("whitelistDetails"),
        blacklistDetails: document.getElementById("blacklistDetails"),
        whitelistCount: document.getElementById("whitelistCount"),
        blacklistCount: document.getElementById("blacklistCount"),
        whitelistUsers: document.getElementById("whitelistUsers"),
        blacklistUsers: document.getElementById("blacklistUsers"),
    };

    let settings = { ...TCH.DEFAULT_SETTINGS };
    let badgeSamples = new Map();
    let currentChannel = null;

    const persist = () => TCH.saveSettings(settings);

    function showError(message) {
        els.newUsernameError.textContent = message;
        els.newUsernameError.hidden = false;
    }

    function clearError() {
        els.newUsernameError.hidden = true;
    }

    // --- Rendu ---------------------------------------------------------------

    function render() {
        els.enabledToggle.checked = settings.enabled;
        els.whitelistColor.value = settings.whitelistColor;
        renderBadges();
        renderUserList("whitelisted", els.whitelistUsers, els.whitelistCount);
        renderUserList("blacklisted", els.blacklistUsers, els.blacklistCount);
    }

    // Twitch donne un libellé distinct à chaque palier d'abonnement ("Abonné à
    // 6 mois", "Abonné à 12 mois"...), donc un badge par palier. Le tri
    // alphabétique les regroupe visuellement. Il n'a aucun effet sur la
    // priorité des couleurs, décidée par l'ordre des badges dans le DOM.
    const byLabel = (a, b) =>
        (a.label || a.key).localeCompare(b.label || b.key);

    function badgeRow(badge) {
        const row = document.createElement("div");
        row.className = "badge-row";

        const label = document.createElement("label");

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = badge.isEnabled;
        checkbox.addEventListener("change", () => {
            badge.isEnabled = checkbox.checked;
            persist();
        });
        label.appendChild(checkbox);

        const sample = badgeSamples.get(badge.key);
        if (sample) {
            const img = document.createElement("img");
            img.src = TCH.badgeImageUrl(sample);
            img.alt = "";
            label.appendChild(img);
        }

        const text = document.createElement("span");
        text.className = "badge-label";
        text.textContent = badge.label || badge.key;
        text.title = badge.label || badge.key;
        label.appendChild(text);

        const color = document.createElement("input");
        color.type = "color";
        color.value = badge.color;
        color.addEventListener("change", () => {
            badge.color = color.value;
            persist();
        });

        row.appendChild(label);
        row.appendChild(color);
        return row;
    }

    function fill(containerEl, badges) {
        containerEl.textContent = "";
        badges.sort(byLabel).forEach((badge) => containerEl.appendChild(badgeRow(badge)));
    }

    // Trois groupes : la chaîne affichée, les badges communs à tout Twitch, et
    // les autres chaînes — repliées pour ne pas encombrer, mais accessibles.
    function renderBadges() {
        const groups = { channel: [], global: [], others: new Map() };

        for (const badge of settings.badges) {
            if (badge.scope === TCH.SCOPE_GLOBAL) {
                groups.global.push(badge);
            } else if (currentChannel && badge.scope === currentChannel) {
                groups.channel.push(badge);
            } else {
                const scope = badge.scope || TCH.SCOPE_UNKNOWN;
                if (!groups.others.has(scope)) groups.others.set(scope, []);
                groups.others.get(scope).push(badge);
            }
        }

        els.channelBadgesTitle.textContent = currentChannel
            ? `${groups.channel.length} badges — ${currentChannel}`
            : "This channel";
        fill(els.channelBadges, groups.channel);

        if (!currentChannel) {
            els.channelBadgesHint.textContent =
                "Open a Twitch channel to see the badges specific to it.";
            els.channelBadgesHint.hidden = false;
        } else if (!groups.channel.length) {
            els.channelBadgesHint.textContent =
                "No channel-specific badge seen yet. They appear as soon as a subscriber or a holder of a custom badge posts.";
            els.channelBadgesHint.hidden = false;
        } else {
            els.channelBadgesHint.hidden = true;
        }

        els.globalBadgesCount.textContent = groups.global.length;
        els.globalBadgesHint.hidden = groups.global.length > 0;
        fill(els.globalBadges, groups.global);

        renderOtherChannels(groups.others);
    }

    function renderOtherChannels(others) {
        els.otherBadges.textContent = "";
        let total = 0;

        [...others.keys()].sort().forEach((scope) => {
            const badges = others.get(scope);
            total += badges.length;

            const heading = document.createElement("div");
            heading.className = "scope-heading";
            heading.textContent =
                scope === TCH.SCOPE_UNKNOWN ? "Unidentified channel" : scope;
            els.otherBadges.appendChild(heading);

            badges.sort(byLabel).forEach((badge) => {
                els.otherBadges.appendChild(badgeRow(badge));
            });
        });

        els.otherBadgesCount.textContent = total;
        els.otherBadgesDetails.hidden = total === 0;
    }

    function renderUserList(list, containerEl, countEl) {
        containerEl.textContent = "";
        const users = settings[list];
        countEl.textContent = users.length;

        users.forEach((login) => {
            const item = document.createElement("div");
            item.className = "user-list-item";

            const name = document.createElement("span");
            name.textContent = login;
            name.title = login;

            const remove = document.createElement("button");
            remove.type = "button";
            remove.textContent = "✕";
            remove.title = `Remove ${login}`;
            remove.addEventListener("click", () => {
                settings[list] = settings[list].filter((user) => user !== login);
                persist();
                render();
            });

            item.appendChild(name);
            item.appendChild(remove);
            containerEl.appendChild(item);
        });
    }

    // --- Actions -------------------------------------------------------------

    function addUser() {
        const login = els.newUsername.value.trim().toLowerCase();
        const list = els.highlightType.value;

        if (!login) return showError("Please enter a username");
        // Les logins Twitch se limitent à ces caractères ; valider ici évite en
        // plus d'injecter n'importe quoi dans le storage.
        if (!TCH.isValidLogin(login)) {
            return showError("Letters, digits and _ only (3-25 chars)");
        }

        clearError();
        els.newUsername.value = "";

        if (settings[list].includes(login)) return;

        // Les deux listes sont exclusives.
        settings.whitelisted = settings.whitelisted.filter((u) => u !== login);
        settings.blacklisted = settings.blacklisted.filter((u) => u !== login);
        settings[list] = [...settings[list], login];

        (list === "whitelisted" ? els.whitelistDetails : els.blacklistDetails).open = true;

        persist();
        render();
    }

    els.addUserButton.addEventListener("click", addUser);
    els.newUsername.addEventListener("keydown", (event) => {
        if (event.key === "Enter") addUser();
    });
    els.newUsername.addEventListener("input", clearError);

    els.enabledToggle.addEventListener("change", () => {
        settings.enabled = els.enabledToggle.checked;
        persist();
    });

    els.whitelistColor.addEventListener("change", () => {
        settings.whitelistColor = els.whitelistColor.value;
        persist();
    });

    // Un badge peut être découvert pendant que le popup est ouvert.
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "sync" && changes[TCH.SETTINGS_KEY]) {
            settings = { ...TCH.DEFAULT_SETTINGS, ...changes[TCH.SETTINGS_KEY].newValue };
            render();
        }
        if (area === "local" && changes[TCH.INDEX_KEY]) {
            badgeSamples = TCH.badgeSamples(TCH.readIndex(changes[TCH.INDEX_KEY].newValue));
            renderBadges();
        }
    });

    // On interroge le content script de l'onglet que le popup recouvre plutôt
    // que de lire une valeur partagée dans le storage : avec plusieurs onglets
    // Twitch ouverts, seul l'onglet actif donne la bonne réponse. Il connaît
    // aussi la chaîne des pages de VOD, que l'URL ne porte pas.
    async function detectChannel() {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) return null;
        try {
            const response = await chrome.tabs.sendMessage(tab.id, { type: "tch:getChannel" });
            const channel = response?.channel;
            return channel && channel !== TCH.SCOPE_UNKNOWN ? channel : null;
        } catch {
            // Onglet sans content script (page hors Twitch).
            return null;
        }
    }

    async function init() {
        const [state, channel] = await Promise.all([TCH.loadState(), detectChannel()]);
        settings = state.settings;
        badgeSamples = TCH.badgeSamples(state.badgeIndex);
        currentChannel = channel;
        render();
    }

    init();
})();
