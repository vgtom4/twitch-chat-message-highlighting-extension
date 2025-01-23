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
    
    const userTypesHighlight = twitchUsersHighlighter.user_types
        .filter((userType) => userType.isEnabled)
        .map(
            (userType) =>
                `.chat-line__message:has(button[data-a-target="chat-badge"] img[alt="${userType.label}"])${twitchUsersHighlighter.blacklisted.map((user) => `:not([data-a-user="${user}"])`).join('')}{ background-color: ${userType.color} !important; }`
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
                            const target = event.target.closest('.chat-line__message');
                            if (target) {
                                const currentUser = target.getAttribute('data-a-user');
                                if (currentUser && currentUser !== lastUser) {
                                    console.log('Current user:', currentUser);
                                    
                                    lastUser = currentUser;

                                    // Delete button all previous buttons
                                    const buttons = document.querySelectorAll('.button-highlight-action');
                                    buttons.forEach((button) => {
                                        button.remove();
                                    });

                                    chrome.storage.local.get('twitchUsersHighlighter', (result) => {
                                        const cachedData = result.twitchUsersHighlighter || { whitelisted: [], blacklisted: [], user_types: [] };

                                        // Create a new button
                                        const button = document.createElement('button');
                                        button.title = cachedData.whitelisted.includes(currentUser) ? 'Remove from whitelist' : 'Add to whitelist';
                                        button.textContent = cachedData.whitelisted.includes(currentUser) ? '-' : '+';
                                        button.className = 'button-highlight-action';
                                        button.classList.add(cachedData.whitelisted.includes(currentUser) ? 'button-highlight-action-remove' : 'button-highlight-action-add');
                                        button.onclick = (e) => {
                                            if (cachedData.whitelisted.includes(currentUser)) {
                                                cachedData.whitelisted = cachedData.whitelisted.filter(user => user !== currentUser);
                                            } else {
                                                cachedData.whitelisted.push(currentUser);
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

                                        // Insert the button before the target element
                                        target.style.position = 'relative';
                                        target.insertBefore(button, target.firstChild);
                                        lastButton = button;
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