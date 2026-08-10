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
        badgeList: document.getElementById("badgeList"),
        badgeHint: document.getElementById("badgeHint"),
        whitelistDetails: document.getElementById("whitelistDetails"),
        blacklistDetails: document.getElementById("blacklistDetails"),
        whitelistCount: document.getElementById("whitelistCount"),
        blacklistCount: document.getElementById("blacklistCount"),
        whitelistUsers: document.getElementById("whitelistUsers"),
        blacklistUsers: document.getElementById("blacklistUsers"),
    };

    let settings = { ...TCH.DEFAULT_SETTINGS };
    let badgeSamples = new Map();

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

    function renderBadges() {
        els.badgeList.textContent = "";
        els.badgeHint.hidden = settings.badges.length > 0;

        // Twitch donne un libellé distinct à chaque palier d'abonnement
        // ("Abonné à 6 mois", "Abonné à 12 mois"...), donc un badge par palier.
        // Le tri alphabétique les regroupe visuellement. Il n'a aucun effet sur
        // la priorité des couleurs, décidée par l'ordre des badges dans le DOM.
        const sorted = [...settings.badges].sort((a, b) =>
            (a.label || a.key).localeCompare(b.label || b.key)
        );

        sorted.forEach((badge) => {
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

            const color = document.createElement("input");
            color.type = "color";
            color.value = badge.color;
            color.addEventListener("change", () => {
                badge.color = color.value;
                persist();
            });

            label.insertBefore(checkbox, label.firstChild);
            label.appendChild(text);
            row.appendChild(label);
            row.appendChild(color);
            els.badgeList.appendChild(row);
        });
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
            badgeSamples = TCH.badgeSamples(changes[TCH.INDEX_KEY].newValue || {});
            renderBadges();
        }
    });

    async function init() {
        const state = await TCH.loadState();
        settings = state.settings;
        badgeSamples = TCH.badgeSamples(state.badgeIndex);
        render();
    }

    init();
})();
