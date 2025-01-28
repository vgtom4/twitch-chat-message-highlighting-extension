// ELEMENTS
const newUsernameElement = document.getElementById("newUsername");
const highlightTypeElement = document.getElementById("highlightType");

const addUserButton = document.getElementById("addUserButton");
const newUsernameError = document.getElementById("new-username-error");

const highlightCheckboxes = document.getElementById("highlightCheckboxes");
const highlightDiffusersMessages = document.getElementById("highlightDiffusersMessages");
const highlightVerifiedMessages = document.getElementById("highlightVerifiedMessages");

const diffuserColor = document.getElementById("diffuserColor");
const verifiedColor = document.getElementById("verifiedColor");

const whitelisterUserListDetails = document.getElementById("whitelisterUserListDetails");
const blacklistedUserListDetails = document.getElementById("blacklistedUserListDetails");
const whitelisterUserListDetailsTitleCount = document.getElementById("whitelisterUserListCount");
const blacklistedUserListDetailsTitleCount = document.getElementById("blacklistedUserListCount");
const whitelisterUserList = document.getElementById("whitelisterUserList");
const blacklistedUserList = document.getElementById("blacklistedUserList");

let cachedUsers = { whitelisted: [], blacklisted: [], highlightedBadges: [{ type: 'diffuser', label: 'Diffuseur', color: '#00643a', isEnabled: true }, { type: 'verified', label: 'Vérifié', color: '#4808fb', isEnabled: true },] };

// Hide/show helpers
const hideElement = (elem) => (elem.style.display = "none");
const showElement = (elem) => (elem.style.display = "");
const disableElement = (elem) => (elem.disabled = true);
const enableElement = (elem) => (elem.disabled = false);

// Add user
const addUser = () => {
	const username = newUsernameElement.value.trim().toLowerCase();
	const highlightType = highlightTypeElement.value;

	if (!username) {
		showElement(newUsernameError);
		return;
	}

	// si l'utilisateur est deja dans la liste, ne rien faire
	if (cachedUsers[highlightType].includes(username)) {
		newUsernameElement.value = "";
		return;
	}

	// Clone cachedUsers pour éviter les modifications par référence
	let updatedUsers = { ...cachedUsers };

	// Vérifier et initialiser la liste si nécessaire
	if (!Array.isArray(updatedUsers[highlightType])) {
		updatedUsers[highlightType] = [];
	}

	// Ajouter le nouvel utilisateur
	updatedUsers[highlightType] = [...updatedUsers[highlightType], username];

	if (highlightType === "whitelisted") {
		// open details
		whitelisterUserListDetails.open = true;
	} else if (highlightType === "blacklisted") {
		// open details
		blacklistedUserListDetails.open = true;
	}

	// si l'utilisateur était déjà dans l'une des autres listes, le retirer
	Object.keys(updatedUsers).filter((key) => key !== highlightType).forEach((key) => {
		updatedUsers[key] = updatedUsers[key].filter((user) => user !== username);
	})

	if (highlightType === "whitelisted") {
		updatedUsers.blacklisted = updatedUsers.blacklisted.filter((user) => user !== username);
	} else if (highlightType === "blacklisted") {
		updatedUsers.whitelisted = updatedUsers.whitelisted.filter((user) => user !== username);
	}

	// Mettre à jour le stockage local
	chrome.storage.local.set({ twitchUsersHighlighter: updatedUsers }, () => {
		// Mettre à jour après la sauvegarde réussie
		cachedUsers = updatedUsers;
		newUsernameElement.value = "";
		hideElement(newUsernameError);
		refreshUsersList(cachedUsers);
	});
};
addUserButton.onclick = () => {
	addUser();
};

newUsernameElement.onkeydown = (e) => {
	if (e.key === "Enter") {
		addUser();
	}
};

// Initialize cachedUsers and refresh UI
chrome.storage.local.get(["twitchUsersHighlighter"], (result) => {
	cachedUsers = result.twitchUsersHighlighter || { whitelisted: [], blacklisted: [], highlightedBadges: [] };
	console.log(cachedUsers);
	
	if (!cachedUsers.whitelisted) {
		cachedUsers.whitelisted = [];
	}
	if (!cachedUsers.blacklisted) {
		cachedUsers.blacklisted = [];
	}
	if (!cachedUsers.highlightedBadges) {
        cachedUsers.highlightedBadges = [{ type: 'diffuser', label: 'Diffuseur', color: '#00643a', isEnabled: true }, { type: 'verified', label: 'Vérifié', color: '#4808fb', isEnabled: true }];
    }
	refreshUsersList(cachedUsers);
});

// Refresh user lists
function refreshUsersList(twitchUsersHighlighter) {
	const { whitelisted, blacklisted, highlightedBadges } = twitchUsersHighlighter || { whitelisted: [], blacklisted: [], highlightedBadges: [] };

	// User badges
	highlightCheckboxes.innerHTML = "";
	(highlightedBadges || []).forEach(({ type, label, color, isEnabled }) => {
		const checkbox = document.createElement("input");
		checkbox.id = `checkbox_user_type_${type}`;
		checkbox.type = "checkbox";
		checkbox.checked = isEnabled;
		checkbox.dataset.userBadge = type;

		const colorInput = document.createElement("input");
		colorInput.type = "color";
		colorInput.id = `color_user_type_${type}`;
		colorInput.value = color;
		colorInput.addEventListener("change", (e) => {
			const updatedUsers = {
				...cachedUsers,
				highlightedBadges: cachedUsers.highlightedBadges.map((userBadge) => {
					if (userBadge.type === type) {
						console.log(e.target.value);
						return { ...userBadge, color: e.target.value };
					}
					return userBadge;
				}),
			};
			cachedUsers = updatedUsers;
			chrome.storage.local.set({ twitchUsersHighlighter: updatedUsers }, () => {
				refreshUsersList(updatedUsers);
			});
		});

		const labelElement = document.createElement("label");
		labelElement.appendChild(checkbox);
		const span = document.createElement("span");
		span.textContent = `Highlight ${label}`;
		labelElement.appendChild(span);

		const divItem = document.createElement("div");
		divItem.className = "checkbox-container-user-types-item";

		divItem.appendChild(labelElement);
		divItem.appendChild(colorInput);

		highlightCheckboxes.appendChild(divItem);
	});

	// Whitelisted users
	whitelisterUserList.innerHTML = "";
	whitelisted.forEach((username) => {
		const userItem = createUserListItem("whitelisted", username);
		whitelisterUserList.appendChild(userItem);
	});

	// Count whitelisted users
	whitelisterUserListCount.textContent = whitelisted.length;

	// Blacklisted users
	blacklistedUserList.innerHTML = "";
	blacklisted.forEach((username) => {
		const userItem = createUserListItem("blacklisted", username);
		blacklistedUserList.appendChild(userItem);
	});

	// Count blacklisted users
	blacklistedUserListDetailsTitleCount.textContent = blacklisted.length;

	// applyDynamicStyles(twitchUsersHighlighter);

	chrome.runtime.sendMessage({
		action: "applyStyles",
		twitchUsersHighlighter: cachedUsers
	});
}

// Create user list item
function createUserListItem(type, username) {
	const div = document.createElement("div");
	div.className = "user-list-item";
	div.style.display = "flex";
	div.style.justifyContent = "space-between";
	div.style.alignItems = "center";
	div.dataset.username = username;

	const span = document.createElement("span");
	span.textContent = username;

	const button = document.createElement("button");
	button.className = "remove-user-button";
	button.textContent = "X";
	button.addEventListener("click", () => removeUser(type, username));

	div.appendChild(span);
	div.appendChild(button);

	return div;
}

// Remove user
function removeUser(type, username) {
	const updatedUsers = {
		...cachedUsers,
		[type]: cachedUsers[type].filter((user) => user !== username),
	};
	console.log(updatedUsers);
	

	chrome.storage.local.set({ twitchUsersHighlighter: updatedUsers }, () => {
		cachedUsers = updatedUsers;
		refreshUsersList(cachedUsers);
	});
}

// Checkbox change event
highlightCheckboxes.addEventListener("change", (e) => {
	const isEnabled = e.target.checked;
	const updatedUsers = {
		...cachedUsers,
		highlightedBadges: cachedUsers.highlightedBadges.map((userBadge) => {
			if (userBadge.type === e.target.dataset.userBadge) {
				return { ...userBadge, isEnabled };
			}
			return userBadge;
		}),
	};
	chrome.storage.local.set({ twitchUsersHighlighter: updatedUsers }, () => {
		cachedUsers = updatedUsers;
		refreshUsersList(cachedUsers);
	});
});

// Fonction pour appliquer les styles dynamiques
function applyDynamicStyles(twitchUsersHighlighter) {
    // Envoyer un message au script de fond pour appliquer les styles
    chrome.runtime.sendMessage({
        action: "applyStyles",
        twitchUsersHighlighter: twitchUsersHighlighter
    });
}