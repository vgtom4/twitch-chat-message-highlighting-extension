// Fonction pour appliquer les styles dans la page active
function applyStylesToTab(twitchUsersHighlighter) {
    const backgroundColor = "#0c6bb8";
    
    if (!twitchUsersHighlighter.whitelisted || twitchUsersHighlighter.whitelisted.length === 0) return;

    const manualHighlight = twitchUsersHighlighter.whitelisted
        .map(
            (user) =>
                `.chat-line__message[data-a-user="${user}"] { background-color: ${backgroundColor} !important; }`
        )
        .join("\n");
    
    const userTypesHighlight = twitchUsersHighlighter.highlightedBadges
        .filter((userBadge) => userBadge.isEnabled)
        .map(
            (userBadge) =>
                `.chat-line__message:has(button[data-a-target="chat-badge"] img[alt*="${userBadge.label}"])${twitchUsersHighlighter.blacklisted.map((user) => `:not([data-a-user="${user}"])`).join('')}{ background-color: ${userBadge.color} !important; }`
        )
        .join("\n");

    // Utiliser chrome.tabs.query pour obtenir l'onglet actif
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs[0];  // On récupère le premier onglet actif
        if (tab) {
            chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: (manualHighlight, userTypesHighlight) => {
                    document.getElementById("twitchUsersHighlighter")?.remove();
                    const style = document.createElement("style");
                    style.id = "twitchUsersHighlighter";
                    style.textContent = manualHighlight + "\n" + userTypesHighlight;
                    document.head.appendChild(style);
                    
                    // Add mouseover listener for user message line
                    const eventId = 'unique-mouseover-listener';
                    if (!document.documentElement.hasAttribute(`data-event-id-${eventId}`)) {
                        let lastUser = null;
                        document.addEventListener('mouseover', (event) => {
                            const userChatMessageLine = event.target.closest('.chat-line__message');
                            if (userChatMessageLine) {
                                const currentUser = userChatMessageLine.getAttribute('data-a-user');
                                if (currentUser && currentUser !== lastUser) {
                                    console.log('Current user:', currentUser);
                                    
                                    lastUser = currentUser;

                                    // Delete button all previous buttons
                                    const buttons = document.querySelectorAll('.button-highlight-action');
                                    buttons.forEach((button) => {
                                        button.remove();
                                    });

                                    chrome.storage.local.get('twitchUsersHighlighter', (result) => {
                                        const cachedData = result.twitchUsersHighlighter || { whitelisted: [], blacklisted: [], highlightedBadges: [] };

                                        const userChatMessageLineHasBadgeType = cachedData.highlightedBadges.some((badgeType) => {
                                            return badgeType.isEnabled && userChatMessageLine.querySelector(`button[data-a-target="chat-badge"] img[alt*="${badgeType.label}"]`);
                                        });

                                        // Create a new button
                                        const button = document.createElement('button');

                                        if (userChatMessageLineHasBadgeType) {
                                            button.title = cachedData.blacklisted.includes(currentUser) ? 'Remove from blacklist' : 'Add to blacklist';
                                            button.textContent = !cachedData.blacklisted.includes(currentUser) ? '-' : '+';
                                            button.className = 'button-highlight-action';
                                            button.classList.add(!cachedData.blacklisted.includes(currentUser) ? 'button-highlight-action-remove' : 'button-highlight-action-add');
                                            button.onclick = (e) => {
                                                if (cachedData.blacklisted.includes(currentUser)) {
                                                    cachedData.blacklisted = cachedData.blacklisted.filter(user => user !== currentUser);
                                                } else {
                                                    cachedData.whitelisted = cachedData.whitelisted.filter(user => user !== currentUser);
                                                    cachedData.blacklisted.push(currentUser);
                                                }
                                                chrome.storage.local.set({ 'twitchUsersHighlighter': cachedData });
                                                chrome.runtime.sendMessage({
                                                    action: "applyStyles",
                                                    twitchUsersHighlighter: cachedData
                                                });
                                                e.target.title = cachedData.blacklisted.includes(currentUser) ? 'Remove from blacklist' : 'Add to blacklist';
                                                e.target.textContent = !cachedData.blacklisted.includes(currentUser) ? '-' : '+';
                                                e.target.className = 'button-highlight-action';
                                                e.target.classList.add(!cachedData.blacklisted.includes(currentUser) ? 'button-highlight-action-remove' : 'button-highlight-action-add');
                                            }
                                        } else {
                                            button.title = cachedData.whitelisted.includes(currentUser) ? 'Remove from whitelist' : 'Add to whitelist';
                                            button.textContent = cachedData.whitelisted.includes(currentUser) ? '-' : '+';
                                            button.className = 'button-highlight-action';
                                            button.classList.add(cachedData.whitelisted.includes(currentUser) ? 'button-highlight-action-remove' : 'button-highlight-action-add');
                                            button.onclick = (e) => {
                                                if (cachedData.whitelisted.includes(currentUser)) {
                                                    cachedData.whitelisted = cachedData.whitelisted.filter(user => user !== currentUser);
                                                } else {
                                                    cachedData.whitelisted.push(currentUser);

                                                    // si l'utilisateur était déjà dans l'une des autres listes, le retirer
                                                    Object.keys(cachedData).filter((key) => key !== "whitelisted").forEach((key) => {
                                                        cachedData[key] = cachedData[key].filter((user) => user !== currentUser);
                                                    })
                                                    cachedData.blacklisted = cachedData.blacklisted.filter((user) => user !== currentUser);
                                                }
                                                chrome.storage.local.set({ 'twitchUsersHighlighter': cachedData });
                                                chrome.runtime.sendMessage({
                                                    action: "applyStyles",
                                                    twitchUsersHighlighter: cachedData
                                                });
                                                e.target.title = cachedData.whitelisted.includes(currentUser) ? 'Remove from whitelist' : 'Add to whitelist';
                                                e.target.textContent = cachedData.whitelisted.includes(currentUser) ? '-' : '+';
                                                e.target.className = 'button-highlight-action';
                                                e.target.classList.add(cachedData.whitelisted.includes(currentUser) ? 'button-highlight-action-remove' : 'button-highlight-action-add');
                                            };
                                        }

                                        // Insert the button before the target element
                                        userChatMessageLine.style.position = 'relative';
                                        userChatMessageLine.insertBefore(button, userChatMessageLine.firstChild);
                                    });
                                }
                            }
                        });
                        document.documentElement.setAttribute(`data-event-id-${eventId}`, 'true');
                    }
                },
                args: [manualHighlight, userTypesHighlight],
            });
        }
    });
}

// Écouter les messages venant du popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "applyStyles") {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            applyStylesToTab(message.twitchUsersHighlighter);
        });
    }
});