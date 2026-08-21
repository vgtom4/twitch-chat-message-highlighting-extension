// Code partagé entre le content script et le popup.
// Chargé en premier dans les deux contextes, expose l'objet global `TCH`.
// Dans le content script, ce global vit dans le monde isolé de l'extension :
// il n'est pas visible depuis la page Twitch.

globalThis.TCH = (() => {
    "use strict";

    // Firefox n'expose les promesses que sur `browser` : sur `chrome`, les
    // mêmes méthodes n'attendent qu'un callback et renvoient `undefined`. Tout
    // le code étant écrit en `await`, on prend `browser` quand il existe.
    const chrome = globalThis.browser ?? globalThis.chrome;

    const VERSION = 7;

    // Un badge comme un utilisateur peut être ignoré, colorer la ligne, ou au
    // contraire empêcher toute coloration — de quoi écarter un bot sans avoir à
    // coder son nom en dur.
    const MODE = { OFF: "off", WHITE: "white", BLACK: "black" };

    // Lignes de chat visibles. `KNOWN` ajoute aux lignes peintes celles dont
    // une règle existe sans couleur : le troisième état sert alors de filtre
    // sans coloration.
    const FILTER = { ALL: "all", HIGHLIGHTED: "highlighted", KNOWN: "known" };

    // Réglages utilisateur : synchronisés entre les machines, volume faible.
    // Seuls les badges explicitement retenus y figurent — les badges croisés
    // dans le chat vivent en mémoire dans le content script, le temps de la
    // session, et ne sont enregistrés que sur un clic dans le popup.
    const SETTINGS_KEY = "tchSettings";
    // Anciens formats, lus une fois pour la migration puis supprimés.
    // v2-v5 : correspondance imageId -> { key, scope }, désormais portée par la
    // règle elle-même (`badge.imageIds`).
    const INDEX_KEY = "tchBadgeIndex";
    // v1 : tout dans une seule clé.
    const LEGACY_KEY = "twitchUsersHighlighter";

    // Portée d'un badge.
    // - `global` : badge permanent de Twitch. Classement **manuel uniquement** —
    //   rien n'y entre tout seul, et rien n'en sort tout seul.
    // - `event` : vu sur plus d'une chaîne sans avoir été classé à la main.
    //   C'est là que va la promotion automatique : campagnes, drops, badges
    //   temporaires, et tout ce qui n'est pas encore trié.
    // - `<chaîne>` : vu sur une seule chaîne (abonnement, badge custom).
    // - `?` : chaîne non identifiable (certaines pages de VOD).
    const SCOPE_GLOBAL = "global";
    const SCOPE_EVENT = "event";
    const SCOPE_UNKNOWN = "?";

    // Badges volontairement ignorés : jamais découverts, jamais listés, jamais
    // pris en compte pour colorer une ligne. Ils ne disent rien de l'auteur du
    // message, seulement de son vote, et pollueraient les listes.
    const IGNORED_BADGE_IDS = new Set([
        // Prédictions : les deux issues (bleu / rose).
        "e33d8b46-f63b-4e67-996d-4a7dcec0ad33",
        "4b76d5f2-91cc-4400-adf2-908a1e6cfd1e",
    ]);

    const isIgnoredBadge = (imageId) => IGNORED_BADGE_IDS.has(imageId);

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
        version: VERSION,
        // Interrupteur maître : coupe les couleurs *et* le bouton de survol.
        enabled: true,
        // Permet de garder les couleurs sans le bouton dans le chat.
        showHoverButton: true,
        chatFilter: FILTER.ALL,
        // Couleur des utilisateurs qui n'en ont pas choisi une.
        defaultColor: "#0c6bb8",
        // [{ login, mode, color }]
        users: [],
        // [{ key, scope, origin, label, color, mode, imageIds }]
        // `key` = `${scope}|${label normalisé}`, figée tant que la portée ne
        // change pas. `label` suit la langue de l'interface Twitch. `imageIds`
        // porte la correspondance vers le DOM : c'est ce qui identifie le badge.
        badges: [],
    };

    // L'`alt` d'un badge dépend de la langue de l'interface. On s'en sert pour
    // nommer et regrouper, jamais pour la correspondance : celle-ci passe par
    // l'imageId, qui est stable.
    const normalizeLabel = (label) =>
        (label || "").trim().toLowerCase().replace(/\s+/g, " ");

    const isValidLogin = (login) => LOGIN_RE.test(login);

    const extractBadgeId = (src) => {
        const match = BADGE_ID_RE.exec(src || "");
        return match ? match[1] : null;
    };

    const badgeImageUrl = (imageId) => `${BADGE_CDN}/${imageId}/1`;

    // Icône représentative d'une règle. Une règle migrée depuis la v1 n'a pas
    // encore d'imageId : elle en recevra un à la première rencontre.
    const badgeIcon = (badge) =>
        badge.imageIds?.length ? badgeImageUrl(badge.imageIds[0]) : null;

    const pickColor = (index) => AUTO_COLORS[index % AUTO_COLORS.length];

    // Une règle de badge, créée depuis un badge croisé dans le chat.
    const makeBadge = (scope, label, imageIds, color, mode = MODE.WHITE) => ({
        key: makeKey(scope, label),
        scope,
        origin: scope,
        label,
        color,
        mode,
        imageIds: [...imageIds],
    });

    // La portée fait partie de l'identité du badge : le badge "Abonné à 6 mois"
    // de deux chaînes différentes a deux imageIds différents et doit rester
    // deux entrées distinctes, colorables séparément.
    const makeKey = (scope, label) => `${scope}|${normalizeLabel(label)}`;

    const keyScope = (key) => String(key).split("|", 1)[0];

    // Vrai seulement pour le nom d'une chaîne réelle.
    const isChannelScope = (scope) =>
        Boolean(scope) &&
        scope !== SCOPE_GLOBAL &&
        scope !== SCOPE_EVENT &&
        scope !== SCOPE_UNKNOWN;

    // Portée vers laquelle un badge retourne quand on annule un déplacement
    // manuel : sa chaîne d'origine si on la connaît encore.
    const homeScope = (badge) =>
        isChannelScope(badge.origin) ? badge.origin : SCOPE_UNKNOWN;

    const makeUser = (login, mode, color) => ({ login, mode, color: color || null });

    // v1 stockait tout dans chrome.storage.local sous une seule clé, avec des
    // badges codés en dur reconnus par leur `alt`. On conserve les listes
    // d'utilisateurs et les couleurs choisies ; les imageIds se rempliront
    // d'eux-mêmes à la première lecture du chat.
    function migrateLegacy(legacy) {
        const settings = { ...DEFAULT_SETTINGS, users: [], badges: [] };
        const seen = new Set();

        const collect = (list, mode) => {
            if (!Array.isArray(list)) return;
            for (const login of list) {
                if (!isValidLogin(login) || seen.has(login)) continue;
                seen.add(login);
                settings.users.push(makeUser(login, mode));
            }
        };
        collect(legacy.whitelisted, MODE.WHITE);
        collect(legacy.blacklisted, MODE.BLACK);

        if (Array.isArray(legacy.highlightedBadges)) {
            // Les badges de la v1 ("Vérifié", "Diffuseur") sont des badges
            // Twitch communs à toutes les chaînes.
            settings.badges = legacy.highlightedBadges
                .filter((badge) => badge && badge.label)
                .map((badge, index) => ({
                    key: makeKey(SCOPE_GLOBAL, badge.label),
                    scope: SCOPE_GLOBAL,
                    origin: SCOPE_UNKNOWN,
                    label: badge.label,
                    color: badge.color || pickColor(index),
                    mode: badge.isEnabled === false ? MODE.OFF : MODE.WHITE,
                    // Inconnus à ce stade : rattachés à la première rencontre.
                    imageIds: [],
                }));
        }

        return settings;
    }

    // v2 ne rattachait pas les badges à une chaîne : on les considère globaux,
    // ceux qui étaient en réalité propres à une chaîne se re-scinderont à la
    // prochaine visite. v3 séparait les utilisateurs en deux listes et ne
    // connaissait que deux états pour un badge. v5 gardait la correspondance
    // vers le DOM dans un index séparé, replié ici dans `imageIds`. v6 n'avait
    // pas de filtre d'affichage.
    function upgradeSettings(settings, legacyIndex) {
        if (settings.version === VERSION) return settings;

        // Regroupe les imageIds de l'ancien index par clé de badge.
        const imageIdsByKey = new Map();
        for (const [imageId, ref] of Object.entries(legacyIndex || {})) {
            if (!ref?.key) continue;
            if (!imageIdsByKey.has(ref.key)) imageIdsByKey.set(ref.key, []);
            imageIdsByKey.get(ref.key).push(imageId);
        }

        const upgraded = {
            ...DEFAULT_SETTINGS,
            ...settings,
            version: VERSION,
            defaultColor: settings.defaultColor || settings.whitelistColor || DEFAULT_SETTINGS.defaultColor,
            badges: (settings.badges || []).map((badge) => ({
                key: badge.scope ? badge.key : makeKey(SCOPE_GLOBAL, badge.label || badge.key),
                scope: badge.scope || SCOPE_GLOBAL,
                // v4 ne mémorisait pas la chaîne de découverte : la portée
                // courante en est la meilleure approximation.
                origin: badge.origin || badge.scope || SCOPE_UNKNOWN,
                label: badge.label,
                color: badge.color,
                mode: badge.mode || (badge.isEnabled ? MODE.WHITE : MODE.OFF),
                imageIds: badge.imageIds || imageIdsByKey.get(badge.key) || [],
            })),
        };

        if (!Array.isArray(settings.users)) {
            const seen = new Set();
            upgraded.users = [];
            for (const [list, mode] of [
                [settings.whitelisted, MODE.WHITE],
                [settings.blacklisted, MODE.BLACK],
            ]) {
                for (const login of list || []) {
                    if (!isValidLogin(login) || seen.has(login)) continue;
                    seen.add(login);
                    upgraded.users.push(makeUser(login, mode));
                }
            }
        }

        delete upgraded.whitelisted;
        delete upgraded.blacklisted;
        delete upgraded.whitelistColor;
        delete upgraded.onlyHighlighted;
        return upgraded;
    }

    // Renvoie les réglages, en migrant depuis v1-v5 si nécessaire.
    async function loadState() {
        const [synced, local] = await Promise.all([
            chrome.storage.sync.get(SETTINGS_KEY),
            chrome.storage.local.get([INDEX_KEY, LEGACY_KEY]),
        ]);

        let settings = synced[SETTINGS_KEY];
        let migrated = false;

        if (settings) {
            const upgraded = upgradeSettings(settings, readLegacyIndex(local[INDEX_KEY]));
            migrated = upgraded !== settings;
            settings = upgraded;
        } else if (local[LEGACY_KEY]) {
            settings = migrateLegacy(local[LEGACY_KEY]);
            migrated = true;
        } else {
            settings = { ...DEFAULT_SETTINGS };
        }

        // Défensif : le storage peut avoir été écrit par une version antérieure.
        settings.users = settings.users || [];
        settings.badges = settings.badges || [];

        // Rejoué à chaque chargement, pas au fil d'une migration : ajouter un
        // identifiant à IGNORED_BADGE_IDS suffit alors à purger ce qui a déjà
        // été retenu, sans nouvelle version de schéma.
        const purged = purgeIgnored(settings);

        if (migrated || purged) await saveSettings(settings);
        // L'index a été replié dans les règles : la clé n'a plus lieu d'être.
        if (migrated && local[INDEX_KEY]) await chrome.storage.local.remove(INDEX_KEY);

        return { settings };
    }

    // Retire les imageIds ignorés des règles, et les règles qui n'en avaient
    // que de tels. Une règle sans aucun imageId est laissée tranquille : elle
    // vient d'une migration et attend sa première rencontre.
    function purgeIgnored(settings) {
        let changed = false;
        const kept = [];

        for (const badge of settings.badges) {
            const imageIds = badge.imageIds || [];
            const clean = imageIds.filter((imageId) => !isIgnoredBadge(imageId));
            if (clean.length === imageIds.length) {
                kept.push(badge);
                continue;
            }
            changed = true;
            // Tous ses imageIds étaient ignorés : la règle n'a plus d'objet.
            if (clean.length) kept.push({ ...badge, imageIds: clean });
        }

        if (changed) settings.badges = kept;
        return changed;
    }

    // Index v2-v5 : imageId -> { key, scope }. Les valeurs de la v2, de simples
    // chaînes, sont ignorées — elles ne portaient pas la portée.
    function readLegacyIndex(raw) {
        if (!raw) return {};
        const index = {};
        for (const [imageId, value] of Object.entries(raw)) {
            if (value && typeof value === "object" && value.key) {
                index[imageId] = { key: value.key, scope: value.scope || SCOPE_GLOBAL };
            }
        }
        return index;
    }

    const saveSettings = (settings) =>
        chrome.storage.sync.set({ [SETTINGS_KEY]: settings });

    return {
        VERSION,
        MODE,
        FILTER,
        makeUser,
        SETTINGS_KEY,
        INDEX_KEY,
        LEGACY_KEY,
        SCOPE_GLOBAL,
        SCOPE_EVENT,
        SCOPE_UNKNOWN,
        DEFAULT_SETTINGS,
        AUTO_COLORS,
        homeScope,
        IGNORED_BADGE_IDS,
        isIgnoredBadge,
        normalizeLabel,
        isValidLogin,
        extractBadgeId,
        badgeImageUrl,
        badgeIcon,
        pickColor,
        makeKey,
        makeBadge,
        keyScope,
        isChannelScope,
        migrateLegacy,
        upgradeSettings,
        loadState,
        readLegacyIndex,
        purgeIgnored,
        saveSettings,
    };
})();
