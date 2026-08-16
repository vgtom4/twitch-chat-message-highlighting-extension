// Le popup ne fait qu'écrire dans chrome.storage : les onglets Twitch ouverts
// réagissent d'eux-mêmes via chrome.storage.onChanged.

(() => {
    "use strict";

    const els = {
        enabledToggle: document.getElementById("enabledToggle"),
        settingsButton: document.getElementById("settingsButton"),
        settingsPanel: document.getElementById("settingsPanel"),
        resetBadges: document.getElementById("resetBadges"),
        resetUsers: document.getElementById("resetUsers"),
        resetAll: document.getElementById("resetAll"),
        hoverToggle: document.getElementById("hoverToggle"),
        chatFilter: document.getElementById("chatFilter"),
        newUsername: document.getElementById("newUsername"),
        newUserMode: document.getElementById("newUserMode"),
        addUserButton: document.getElementById("addUserButton"),
        newUsernameError: document.getElementById("newUsernameError"),
        defaultColor: document.getElementById("defaultColor"),
        seenBadges: document.getElementById("seenBadges"),
        seenHint: document.getElementById("seenHint"),
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
    // Badges croisés dans le chat de l'onglet actif, sans règle. Relus auprès
    // de l'onglet, jamais enregistrés : c'est le clic qui crée la règle.
    let seen = [];
    let currentChannel = null;

    const persist = () => TCH.saveSettings(settings);

    // Les lignes déjà affichées capturent des objets de `settings`, qui est
    // remplacé à chaque `onChanged`. On repart donc de la clé pour agir sur
    // l'objet vivant, jamais sur celui capturé par la closure.
    const liveBadge = (key) => settings.badges.find((badge) => badge.key === key);
    const liveUser = (login) => settings.users.find((user) => user.login === login);

    function showError(message) {
        els.newUsernameError.textContent = message;
        els.newUsernameError.hidden = false;
    }

    const clearError = () => (els.newUsernameError.hidden = true);

    // --- Cellules communes aux deux tables -----------------------------------

    // Deux bascules plutôt qu'un menu : le troisième état est simplement
    // "aucune des deux", et un clic suffit pour passer de l'un à l'autre.
    function modeGroup(entry, onChange) {
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

        return group;
    }

    function modeCell(entry, onChange) {
        const cell = document.createElement("td");
        cell.className = "col-mode";
        cell.appendChild(modeGroup(entry, onChange));
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
                        const live = liveUser(user.login);
                        if (!live) return;
                        live.mode = mode;
                        persist();
                        renderUsers();
                    })
                );

                row.appendChild(
                    colorCell(user.color || settings.defaultColor, user.mode === MODE.WHITE, (color) => {
                        const live = liveUser(user.login);
                        if (!live) return;
                        live.color = color;
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
                    settings.users = settings.users.filter((u) => u.login !== user.login);
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

    // Déplacer un badge revient à changer sa clé : elle contient la portée. Les
    // imageIds voyagent avec la règle, il n'y a plus d'index à réaligner.
    //
    // Tout est synchrone jusqu'à l'écriture : aucun `await` ne doit séparer la
    // mutation de `settings` de son enregistrement.
    function moveBadge(key, scope) {
        const badge = liveBadge(key);
        if (!badge) return;

        const target = badge.scope === scope ? TCH.homeScope(badge) : scope;
        if (target === badge.scope) return;

        const nextKey = TCH.makeKey(target, badge.label || badge.key);
        const collision = settings.badges.find(
            (other) => other !== badge && other.key === nextKey
        );

        // Une règle existe déjà à destination : les deux fusionnent.
        if (collision) {
            if (collision.mode === MODE.OFF) collision.mode = badge.mode;
            collision.imageIds = [
                ...new Set([...collision.imageIds, ...badge.imageIds]),
            ];
            settings.badges = settings.badges.filter((other) => other !== badge);
        } else {
            badge.key = nextKey;
            badge.scope = target;
        }

        persist();
        render();
    }

    // --- Badges croisés dans le chat ----------------------------------------

    // Un clic crée la règle : c'est le seul moment où un badge est enregistré.
    async function adoptBadge(entry) {
        // Sur une VOD, la chaîne peut n'être identifiée qu'après l'ouverture du
        // popup : on la redemande avant de figer la portée, car c'est elle qui
        // fait foi et non celle mémorisée à l'apparition du badge.
        await syncTab();

        const scope =
            currentChannel ||
            (TCH.isChannelScope(entry.scope) ? entry.scope : TCH.SCOPE_UNKNOWN);

        // Déjà une règle sous ce libellé et cette portée : on lui rattache
        // simplement l'imageId au lieu de créer un doublon.
        const existing =
            liveBadge(TCH.makeKey(TCH.SCOPE_GLOBAL, entry.label)) ||
            liveBadge(TCH.makeKey(TCH.SCOPE_EVENT, entry.label)) ||
            liveBadge(TCH.makeKey(scope, entry.label));

        if (existing) {
            if (!existing.imageIds.includes(entry.imageId)) {
                existing.imageIds = [...existing.imageIds, entry.imageId];
            }
            if (existing.mode === MODE.OFF) existing.mode = MODE.WHITE;
        } else {
            settings.badges = [
                ...settings.badges,
                TCH.makeBadge(scope, entry.label, [entry.imageId], TCH.pickColor(settings.badges.length)),
            ];
        }

        // `renderSeen` écarte l'entrée tant qu'elle a une règle : la retirer de
        // `seen` empêcherait de la reproposer.
        persist();
        render();
    }

    function renderSeen() {
        els.seenBadges.textContent = "";
        // Un badge qui a reçu une règle entre-temps ne se propose plus.
        const pending = seen.filter((entry) => !hasRule(entry.imageId));
        els.seenHint.hidden = pending.length > 0;

        pending.forEach((entry) => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "seen-badge";
            button.title = `${entry.label} — click to highlight`;
            button.dataset.imageId = entry.imageId;

            const img = document.createElement("img");
            img.src = TCH.badgeImageUrl(entry.imageId);
            img.alt = entry.label;
            button.appendChild(img);

            button.addEventListener("click", () => adoptBadge(entry));
            els.seenBadges.appendChild(button);
        });
    }

    const hasRule = (imageId) =>
        settings.badges.some((badge) => badge.imageIds?.includes(imageId));

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
            button.addEventListener("click", () => moveBadge(badge.key, scope));
            group.appendChild(button);
        }

        cell.appendChild(group);
        return cell;
    }

    function badgeRow(badge) {
        const row = document.createElement("tr");

        const name = document.createElement("td");
        name.className = "col-name";

        // L'icône laisse place à une croix au survol de la ligne : la place est
        // comptée, et supprimer une règle reste rare. Elle est aussi présente
        // sans icône, pour les règles migrées qui n'ont pas encore d'imageId.
        const slot = document.createElement("span");
        slot.className = "badge-icon";

        const icon = TCH.badgeIcon(badge);
        if (icon) {
            const img = document.createElement("img");
            img.src = icon;
            img.alt = "";
            slot.appendChild(img);
        }

        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "badge-remove";
        remove.textContent = "✕";
        remove.title = `Remove the rule for ${badge.label || badge.key}`;
        remove.addEventListener("click", () => {
            settings.badges = settings.badges.filter((other) => other.key !== badge.key);
            render();
            persist().then(syncTab);
        });
        slot.appendChild(remove);
        name.appendChild(slot);

        const text = document.createElement("span");
        text.className = "badge-label";
        text.textContent = badge.label || badge.key;
        text.title = badge.label || badge.key;
        name.appendChild(text);
        row.appendChild(name);

        row.appendChild(
            modeCell(badge, (mode) => {
                const live = liveBadge(badge.key);
                if (!live) return;
                live.mode = mode;
                persist();
                renderBadges();
            })
        );

        row.appendChild(moveCell(badge));

        row.appendChild(
            colorCell(badge.color, badge.mode !== MODE.BLACK, (color) => {
                const live = liveBadge(badge.key);
                if (!live) return;
                live.color = color;
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
        els.chatFilter.value = settings.chatFilter;
        // Ces deux réglages n'ont pas de sens si tout est coupé.
        els.hoverToggle.disabled = !settings.enabled;
        els.chatFilter.disabled = !settings.enabled;
        renderUsers();
        renderSeen();
        renderBadges();
    }

    // --- Actions -------------------------------------------------------------

    // Mode du prochain utilisateur ajouté.
    const newUser = { mode: MODE.WHITE };

    function renderNewUserMode() {
        els.newUserMode.replaceChildren(
            modeGroup(newUser, (mode) => {
                newUser.mode = mode;
                renderNewUserMode();
            })
        );
    }

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
        if (existing) existing.mode = newUser.mode;
        else settings.users = [...settings.users, TCH.makeUser(login, newUser.mode)];

        els.usersDetails.open = true;
        persist();
        renderUsers();
    }

    renderNewUserMode();

    els.addUserButton.addEventListener("click", addUser);
    els.newUsername.addEventListener("keydown", (event) => {
        if (event.key === "Enter") addUser();
    });
    els.newUsername.addEventListener("input", clearError);

    els.enabledToggle.addEventListener("change", () => {
        settings.enabled = els.enabledToggle.checked;
        els.hoverToggle.disabled = !settings.enabled;
        els.chatFilter.disabled = !settings.enabled;
        persist();
    });

    els.hoverToggle.addEventListener("change", () => {
        settings.showHoverButton = els.hoverToggle.checked;
        persist();
    });

    els.chatFilter.addEventListener("change", () => {
        settings.chatFilter = els.chatFilter.value;
        persist();
    });

    els.defaultColor.addEventListener("change", () => {
        settings.defaultColor = els.defaultColor.value;
        persist();
        renderUsers();
    });

    // --- Panneau de réglages -------------------------------------------------

    // Les remises à zéro sont irréversibles : on demande un second clic plutôt
    // qu'un confirm(), qui ferme le popup sur certaines plateformes.
    const resetButtons = [els.resetBadges, els.resetUsers, els.resetAll];
    let armedTimer = null;

    function disarm(button) {
        button.classList.remove("armed");
        button.textContent = button.dataset.label;
        delete button.dataset.armed;
    }

    function arm(button) {
        resetButtons.forEach(disarm);
        clearTimeout(armedTimer);
        button.dataset.armed = "true";
        button.classList.add("armed");
        button.textContent = "Click again to confirm";
        armedTimer = setTimeout(() => disarm(button), 4000);
    }

    function onReset(button, apply) {
        button.addEventListener("click", () => {
            if (!button.dataset.armed) return arm(button);
            clearTimeout(armedTimer);
            disarm(button);
            apply();
        });
    }

    els.settingsButton.addEventListener("click", () => {
        const open = els.settingsPanel.hidden;
        els.settingsPanel.hidden = !open;
        els.settingsButton.setAttribute("aria-expanded", String(open));
        els.settingsButton.classList.toggle("active", open);
        // Ne pas laisser un bouton armé derrière un panneau replié.
        if (!open) resetButtons.forEach(disarm);
    });

    onReset(els.resetBadges, () => {
        settings.badges = [];
        render();
        persist().then(syncTab);
    });

    onReset(els.resetUsers, () => {
        settings.users = [];
        persist();
        render();
    });

    onReset(els.resetAll, () => {
        settings = { ...TCH.DEFAULT_SETTINGS, users: [], badges: [] };
        render();
        persist().then(syncTab);
    });

    // Les réglages peuvent changer sous nos pieds : autre onglet, ou entretien
    // d'une règle par un content script.
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "sync" && changes[TCH.SETTINGS_KEY]) {
            settings = { ...TCH.DEFAULT_SETTINGS, ...changes[TCH.SETTINGS_KEY].newValue };
            render();
            // Souvent le signe d'une chaîne identifiée après coup.
            syncTab();
        }
    });

    // On interroge le content script de l'onglet que le popup recouvre plutôt
    // que de lire une valeur partagée dans le storage : avec plusieurs onglets
    // Twitch ouverts, seul l'onglet actif donne la bonne réponse. Il connaît
    // aussi la chaîne des pages de VOD, que l'URL ne porte pas, et les badges
    // croisés dans ce chat, qui ne sont enregistrés nulle part.
    async function askTab() {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) return {};
        try {
            return (await chrome.tabs.sendMessage(tab.id, { type: "tch:getState" })) || {};
        } catch {
            // Onglet sans content script (page hors Twitch).
            return {};
        }
    }

    function applyTabState(tabState) {
        currentChannel =
            tabState.channel && tabState.channel !== TCH.SCOPE_UNKNOWN ? tabState.channel : null;
        // Ordre d'apparition dans le chat : les badges les plus courants
        // (diffuseur, modérateur, abonné) arrivent en tête.
        seen = tabState.seen || [];
    }

    // L'état de l'onglet bouge pendant que le popup est ouvert : chaîne
    // identifiée après coup, badge reproposé après le retrait d'une règle.
    async function syncTab() {
        applyTabState(await askTab());
        render();
    }

    async function init() {
        const [state, tabState] = await Promise.all([TCH.loadState(), askTab()]);
        settings = state.settings;
        applyTabState(tabState);
        render();
    }

    init();
})();
