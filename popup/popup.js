// Le popup ne fait qu'écrire dans chrome.storage : les onglets Twitch ouverts
// réagissent d'eux-mêmes via chrome.storage.onChanged. Plus de service worker
// ni d'injection de script à la demande.

(() => {
    "use strict";

    const els = {
        enabledToggle: document.getElementById("enabledToggle"),
        hoverToggle: document.getElementById("hoverToggle"),
        newUsername: document.getElementById("newUsername"),
        newUserMode: document.getElementById("newUserMode"),
        addUserButton: document.getElementById("addUserButton"),
        newUsernameError: document.getElementById("newUsernameError"),
        defaultColor: document.getElementById("defaultColor"),
        usersBody: document.getElementById("usersBody"),
        usersTable: document.getElementById("usersTable"),
        usersCount: document.getElementById("usersCount"),
        usersHint: document.getElementById("usersHint"),
        usersDetails: document.getElementById("usersDetails"),
        channelBadges: document.getElementById("channelBadges"),
        channelBadgesTitle: document.getElementById("channelBadgesTitle"),
        channelBadgesHint: document.getElementById("channelBadgesHint"),
        eventBadges: document.getElementById("eventBadges"),
        eventBadgesCount: document.getElementById("eventBadgesCount"),
        eventBadgesHint: document.getElementById("eventBadgesHint"),
        globalBadges: document.getElementById("globalBadges"),
        globalBadgesCount: document.getElementById("globalBadgesCount"),
        globalBadgesHint: document.getElementById("globalBadgesHint"),
        otherBadges: document.getElementById("otherBadges"),
        otherBadgesCount: document.getElementById("otherBadgesCount"),
        otherBadgesDetails: document.getElementById("otherBadgesDetails"),
    };

    const { MODE } = TCH;

    let settings = { ...TCH.DEFAULT_SETTINGS };
    let badgeSamples = new Map();
    let currentChannel = null;

    const persist = () => TCH.saveSettings(settings);

    function showError(message) {
        els.newUsernameError.textContent = message;
        els.newUsernameError.hidden = false;
    }

    const clearError = () => (els.newUsernameError.hidden = true);

    // --- Cellules communes aux deux tables -----------------------------------

    // Deux bascules plutôt qu'un menu : le troisième état est simplement
    // "aucune des deux", et un clic suffit pour passer de l'un à l'autre.
    function modeCell(entry, onChange) {
        const cell = document.createElement("td");
        cell.className = "col-mode";

        const group = document.createElement("div");
        group.className = "mode-group";

        for (const [mode, symbol, title] of [
            [MODE.WHITE, "✚", "Highlight"],
            [MODE.BLACK, "⊘", "Never highlight"],
        ]) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = `mode-button mode-${mode}`;
            button.textContent = symbol;
            button.title = title;
            button.setAttribute("aria-pressed", String(entry.mode === mode));
            button.addEventListener("click", () => {
                // Recliquer sur le mode courant le désactive.
                onChange(entry.mode === mode ? MODE.OFF : mode);
            });
            group.appendChild(button);
        }

        cell.appendChild(group);
        return cell;
    }

    function colorCell(value, enabled, onChange) {
        const cell = document.createElement("td");
        cell.className = "col-color";

        const input = document.createElement("input");
        input.type = "color";
        input.value = value;
        input.disabled = !enabled;
        // Une entrée exclue n'a pas de couleur : on grise plutôt que de retirer
        // le champ, pour que les colonnes restent alignées.
        input.title = enabled ? "Highlight color" : "Not used in exclude mode";
        input.addEventListener("change", () => onChange(input.value));

        cell.appendChild(input);
        return cell;
    }

    // --- Table des utilisateurs ----------------------------------------------

    function renderUsers() {
        els.usersBody.textContent = "";
        els.usersCount.textContent = settings.users.length;
        els.usersHint.hidden = settings.users.length > 0;
        els.usersTable.hidden = settings.users.length === 0;
        els.defaultColor.value = settings.defaultColor;

        [...settings.users]
            .sort((a, b) => a.login.localeCompare(b.login))
            .forEach((user) => {
                const row = document.createElement("tr");

                const name = document.createElement("td");
                name.className = "col-name";
                name.textContent = user.login;
                name.title = user.login;
                row.appendChild(name);

                row.appendChild(
                    modeCell(user, (mode) => {
                        user.mode = mode;
                        persist();
                        renderUsers();
                    })
                );

                row.appendChild(
                    colorCell(user.color || settings.defaultColor, user.mode === MODE.WHITE, (color) => {
                        user.color = color;
                        persist();
                    })
                );

                const removeCell = document.createElement("td");
                removeCell.className = "col-remove";
                const remove = document.createElement("button");
                remove.type = "button";
                remove.className = "remove-button";
                remove.textContent = "✕";
                remove.title = `Remove ${user.login}`;
                remove.addEventListener("click", () => {
                    settings.users = settings.users.filter((u) => u !== user);
                    persist();
                    renderUsers();
                });
                removeCell.appendChild(remove);
                row.appendChild(removeCell);

                els.usersBody.appendChild(row);
            });
    }

    // --- Tables de badges ----------------------------------------------------

    // Twitch donne un libellé distinct à chaque palier d'abonnement ("Abonné à
    // 6 mois", "Abonné à 12 mois"...), donc un badge par palier. Le tri
    // alphabétique les regroupe visuellement. Il n'a aucun effet sur la
    // priorité des couleurs, décidée par l'ordre des badges dans le DOM.
    const byLabel = (a, b) => (a.label || a.key).localeCompare(b.label || b.key);

    // Déplacer un badge revient à changer sa clé : elle contient la portée. On
    // reporte le changement sur l'index des imageIds, sinon le content script
    // ne retrouverait plus l'entrée et en recréerait une.
    async function moveBadge(badge, scope) {
        const previousKey = badge.key;
        const target = badge.scope === scope ? TCH.homeScope(badge) : scope;
        if (target === badge.scope) return;

        const nextKey = TCH.makeKey(target, badge.label || badge.key);
        const collision = settings.badges.find(
            (other) => other !== badge && other.key === nextKey
        );

        // Une entrée existe déjà à destination : les deux fusionnent.
        if (collision) {
            if (collision.mode === MODE.OFF) collision.mode = badge.mode;
            settings.badges = settings.badges.filter((other) => other !== badge);
        } else {
            badge.key = nextKey;
            badge.scope = target;
        }

        const winnerKey = collision ? collision.key : nextKey;
        const winnerScope = collision ? collision.scope : target;

        const raw = await chrome.storage.local.get(TCH.INDEX_KEY);
        const index = TCH.readIndex(raw[TCH.INDEX_KEY]);
        let touched = false;
        for (const [imageId, ref] of Object.entries(index)) {
            if (ref.key !== previousKey) continue;
            index[imageId] = { key: winnerKey, scope: winnerScope };
            touched = true;
        }

        persist();
        if (touched) await TCH.saveBadgeIndex(index);
        else render();
    }

    function moveCell(badge) {
        const cell = document.createElement("td");
        cell.className = "col-move";

        const group = document.createElement("div");
        group.className = "move-group";

        for (const [scope, symbol, title] of [
            [TCH.SCOPE_EVENT, "E", "Move to Event badges"],
            [TCH.SCOPE_GLOBAL, "G", "Move to Global badges"],
        ]) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = `move-button move-${scope}`;
            button.textContent = symbol;
            const here = badge.scope === scope;
            const home = TCH.homeScope(badge);
            button.setAttribute("aria-pressed", String(here));
            button.title = here
                ? home === TCH.SCOPE_UNKNOWN
                    ? "Move back out of this list"
                    : `Move back to ${home}`
                : title;
            button.addEventListener("click", () => moveBadge(badge, scope));
            group.appendChild(button);
        }

        cell.appendChild(group);
        return cell;
    }

    function badgeRow(badge) {
        const row = document.createElement("tr");

        const name = document.createElement("td");
        name.className = "col-name";

        const sample = badgeSamples.get(badge.key);
        if (sample) {
            const img = document.createElement("img");
            img.src = TCH.badgeImageUrl(sample);
            img.alt = "";
            name.appendChild(img);
        }

        const text = document.createElement("span");
        text.className = "badge-label";
        text.textContent = badge.label || badge.key;
        text.title = badge.label || badge.key;
        name.appendChild(text);
        row.appendChild(name);

        row.appendChild(
            modeCell(badge, (mode) => {
                badge.mode = mode;
                persist();
                renderBadges();
            })
        );

        row.appendChild(moveCell(badge));

        row.appendChild(
            colorCell(badge.color, badge.mode !== MODE.BLACK, (color) => {
                badge.color = color;
                persist();
            })
        );

        return row;
    }

    function fill(bodyEl, badges) {
        bodyEl.textContent = "";
        badges.sort(byLabel).forEach((badge) => bodyEl.appendChild(badgeRow(badge)));
    }

    // Trois groupes : la chaîne affichée, les badges communs à tout Twitch, et
    // les autres chaînes — repliées pour ne pas encombrer, mais accessibles.
    function renderBadges() {
        const groups = { channel: [], global: [], event: [], others: new Map() };

        for (const badge of settings.badges) {
            if (badge.scope === TCH.SCOPE_GLOBAL) {
                groups.global.push(badge);
            } else if (badge.scope === TCH.SCOPE_EVENT) {
                groups.event.push(badge);
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

        els.eventBadgesCount.textContent = groups.event.length;
        els.eventBadgesHint.hidden = groups.event.length > 0;
        fill(els.eventBadges, groups.event);

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

            const headingRow = document.createElement("tr");
            // Marquée pour que le CSS l'écarte du survol et n'indente que les
            // lignes de badge qui la suivent.
            headingRow.className = "scope-row";
            const heading = document.createElement("td");
            heading.colSpan = 4;
            heading.className = "scope-heading";
            heading.textContent =
                scope === TCH.SCOPE_UNKNOWN ? "Unidentified channel" : scope;
            headingRow.appendChild(heading);
            els.otherBadges.appendChild(headingRow);

            badges.sort(byLabel).forEach((badge) => {
                els.otherBadges.appendChild(badgeRow(badge));
            });
        });

        els.otherBadgesCount.textContent = total;
        els.otherBadgesDetails.hidden = total === 0;
    }

    function render() {
        els.enabledToggle.checked = settings.enabled;
        els.hoverToggle.checked = settings.showHoverButton;
        // Le bouton de survol n'a pas de sens si tout est coupé.
        els.hoverToggle.disabled = !settings.enabled;
        renderUsers();
        renderBadges();
    }

    // --- Actions -------------------------------------------------------------

    function addUser() {
        const login = els.newUsername.value.trim().toLowerCase();

        if (!login) return showError("Please enter a username");
        // Les logins Twitch se limitent à ces caractères ; valider ici évite en
        // plus d'injecter n'importe quoi dans le storage.
        if (!TCH.isValidLogin(login)) {
            return showError("Letters, digits and _ only (3-25 chars)");
        }

        clearError();
        els.newUsername.value = "";

        const existing = settings.users.find((user) => user.login === login);
        if (existing) existing.mode = els.newUserMode.value;
        else settings.users = [...settings.users, TCH.makeUser(login, els.newUserMode.value)];

        els.usersDetails.open = true;
        persist();
        renderUsers();
    }

    els.addUserButton.addEventListener("click", addUser);
    els.newUsername.addEventListener("keydown", (event) => {
        if (event.key === "Enter") addUser();
    });
    els.newUsername.addEventListener("input", clearError);

    els.enabledToggle.addEventListener("change", () => {
        settings.enabled = els.enabledToggle.checked;
        els.hoverToggle.disabled = !settings.enabled;
        persist();
    });

    els.hoverToggle.addEventListener("change", () => {
        settings.showHoverButton = els.hoverToggle.checked;
        persist();
    });

    els.defaultColor.addEventListener("change", () => {
        settings.defaultColor = els.defaultColor.value;
        persist();
        renderUsers();
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
