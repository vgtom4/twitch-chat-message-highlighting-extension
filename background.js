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