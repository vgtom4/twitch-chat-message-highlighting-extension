// Code partagé entre le content script et le popup.
// Chargé en premier dans les deux contextes, expose l'objet global `TCH`.
// Dans le content script, ce global vit dans le monde isolé de l'extension :
// il n'est pas visible depuis la page Twitch.

globalThis.TCH = (() => {
    "use strict";

    // Réglages utilisateur : synchronisés entre les machines, volume faible.
    const SETTINGS_KEY = "tchSettings";
    // Correspondance imageId de badge -> clé de badge. Cache local, croît avec
    // les chaînes visitées (paliers d'abonnement, badges custom).
    const INDEX_KEY = "tchBadgeIndex";
    // Ancien format v1, lu une seule fois pour la migration.
    const LEGACY_KEY = "twitchUsersHighlighter";

    const BADGE_ID_RE = /\/badges\/v1\/([^/?#]+)/;
    const BADGE_CDN = "https://static-cdn.jtvnw.net/badges/v1";
    const LOGIN_RE = /^[a-zA-Z0-9_]{3,25}$/;

    // Couleurs attribuées automatiquement aux badges découverts, dans l'ordre.
    const AUTO_COLORS = [
        "#4808fb",
        "#00643a",
        "#8b5d0b",
        "#0b6b6b",
        "#8b0b4a",
        "#5a0b8b",
        "#7a3d00",
        "#0b3f8b",
    ];

    const DEFAULT_SETTINGS = {
        version: 2,
        enabled: true,
        whitelistColor: "#0c6bb8",
        whitelisted: [],
        blacklisted: [],
        // [{ key, label, color, isEnabled }]
        // `key` est figée à la création (label normalisé du premier badge vu),
        // `label` suit la langue de l'interface Twitch.
        badges: [],
    };

    // L'`alt` d'un badge dépend de la langue de l'interface. On s'en sert comme
    // clé de regroupement (tous les paliers d'abonnement partagent le même alt),
    // jamais comme critère de correspondance : celle-ci passe par l'imageId.
    const normalizeLabel = (label) =>
        (label || "").trim().toLowerCase().replace(/\s+/g, " ");

    const isValidLogin = (login) => LOGIN_RE.test(login);

    const extractBadgeId = (src) => {
        const match = BADGE_ID_RE.exec(src || "");
        return match ? match[1] : null;
    };

    const badgeImageUrl = (imageId) => `${BADGE_CDN}/${imageId}/1`;

    const pickColor = (index) => AUTO_COLORS[index % AUTO_COLORS.length];

    // v1 stockait tout dans chrome.storage.local sous une seule clé, avec des
    // badges codés en dur reconnus par leur `alt`. On conserve les listes
    // d'utilisateurs et les couleurs choisies ; les imageIds se rempliront
    // d'eux-mêmes à la première lecture du chat.
    function migrateLegacy(legacy) {
        const settings = {
            ...DEFAULT_SETTINGS,
            whitelisted: [],
            blacklisted: [],
            badges: [],
        };

        if (Array.isArray(legacy.whitelisted)) {
            settings.whitelisted = legacy.whitelisted.filter(isValidLogin);
        }
        if (Array.isArray(legacy.blacklisted)) {
            settings.blacklisted = legacy.blacklisted.filter(isValidLogin);
        }
        if (Array.isArray(legacy.highlightedBadges)) {
            settings.badges = legacy.highlightedBadges
                .filter((badge) => badge && badge.label)
                .map((badge, index) => ({
                    key: normalizeLabel(badge.label),
                    label: badge.label,
                    color: badge.color || pickColor(index),
                    isEnabled: badge.isEnabled !== false,
                }));
        }

        return settings;
    }

    // Renvoie { settings, badgeIndex }. Migre depuis v1 au premier appel si
    // aucun réglage v2 n'existe encore.
    async function loadState() {
        const [synced, local] = await Promise.all([
            chrome.storage.sync.get(SETTINGS_KEY),
            chrome.storage.local.get([INDEX_KEY, LEGACY_KEY]),
        ]);

        const badgeIndex = local[INDEX_KEY] || {};
        let settings = synced[SETTINGS_KEY];

        if (settings) {
            settings = { ...DEFAULT_SETTINGS, ...settings };
        } else if (local[LEGACY_KEY]) {
            settings = migrateLegacy(local[LEGACY_KEY]);
            await saveSettings(settings);
        } else {
            settings = { ...DEFAULT_SETTINGS };
        }

        // Défensif : le storage peut avoir été écrit par une version antérieure.
        settings.whitelisted = settings.whitelisted || [];
        settings.blacklisted = settings.blacklisted || [];
        settings.badges = settings.badges || [];

        return { settings, badgeIndex };
    }

    const saveSettings = (settings) =>
        chrome.storage.sync.set({ [SETTINGS_KEY]: settings });

    const saveBadgeIndex = (badgeIndex) =>
        chrome.storage.local.set({ [INDEX_KEY]: badgeIndex });

    // clé de badge -> un imageId représentatif, pour afficher l'icône réelle.
    function badgeSamples(badgeIndex) {
        const samples = new Map();
        for (const [imageId, key] of Object.entries(badgeIndex)) {
            if (!samples.has(key)) samples.set(key, imageId);
        }
        return samples;
    }

    return {
        SETTINGS_KEY,
        INDEX_KEY,
        LEGACY_KEY,
        DEFAULT_SETTINGS,
        AUTO_COLORS,
        normalizeLabel,
        isValidLogin,
        extractBadgeId,
        badgeImageUrl,
        pickColor,
        migrateLegacy,
        loadState,
        saveSettings,
        saveBadgeIndex,
        badgeSamples,
    };
})();
