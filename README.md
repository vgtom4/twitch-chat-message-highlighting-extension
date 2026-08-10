# Twitch Chat Messages Highlighting

Extension Chrome qui colore les messages du chat Twitch (live et VOD) selon
l'utilisateur ou le badge qu'il porte.

## Architecture (v2)

| Fichier      | Rôle                                                        |
| ------------ | ----------------------------------------------------------- |
| `shared.js`  | Modèle de données, migration v1→v2, helpers. Chargé dans le content script et le popup, expose `TCH`. |
| `content.js` | Observe le chat, résout les badges, applique les highlights, gère le bouton de survol. |
| `styles.css` | Une règle de highlight + le style du bouton. Aucune génération dynamique. |
| `popup/`     | Réglages. N'écrit que dans `chrome.storage`.                 |

Il n'y a **pas de service worker** : le popup écrit dans le storage, les onglets
réagissent via `chrome.storage.onChanged`.

### Correspondance des badges

Le matching se fait sur l'**imageId** du badge, extrait de
`https://static-cdn.jtvnw.net/badges/v1/<imageId>/1`, et non sur l'attribut
`alt` — celui-ci change avec la langue de l'interface Twitch.

Les badges sont découverts en lisant le chat : au premier message portant un
badge inconnu, une entrée est créée (désactivée par défaut) et apparaît dans le
popup avec son icône réelle. Aucune API Twitch, aucun Client-Id, aucun OAuth.

- `sync.tchSettings` — listes, couleurs, badges activés.
- `local.tchBadgeIndex` — `imageId` → `{ key, scope }` (cache, croît avec les chaînes visitées).

Si l'utilisateur change la langue de Twitch, l'imageId reste connu : seul le
libellé affiché est mis à jour, sans créer de doublon.

### Portée d'un badge

Un badge appartient à l'une de trois portées, et sa clé est
`${portée}|${libellé normalisé}` :

| Portée | Contenu |
| ------ | ------- |
| `global` | badges communs à tout Twitch : vérifié, prime, modérateur, VIP… |
| `<chaîne>` | badges propres à un streamer : paliers d'abonnement, badges custom |
| `?` | chaîne non identifiable (certaines pages de VOD) |

La classification est déduite de l'observation, sans API : **un imageId vu sur
deux chaînes différentes est forcément un badge commun** et se promeut en
`global`, en fusionnant avec l'entrée globale existante s'il y en a une. Un
badge qui n'apparaît que sur une chaîne lui reste attaché, avec sa propre
couleur — l'« Abonné à 6 mois » de deux streamers sont deux entrées distinctes.

Un badge découvert alors que la chaîne est indéterminée prend la portée `?`,
puis est rattaché à la chaîne dès qu'elle est identifiée (et non promu global).

Le popup range les badges en trois `<details>` : ceux de la chaîne affichée
(déplié), les globaux, et les autres chaînes (replié, groupé par chaîne). Il
obtient le nom de la chaîne en interrogeant le content script de l'onglet actif
— pas via une valeur partagée dans le storage, qui serait fausse avec plusieurs
onglets Twitch ouverts.

La chaîne est lue dans l'URL (`/<chaîne>`, `/popout/<chaîne>/chat`,
`/moderator/<chaîne>`, `dashboard.twitch.tv/u/<chaîne>`), avec repli sur un lien
de chaîne du DOM pour les pages de VOD, dont l'URL ne porte que l'id de vidéo.

### Règles : trois états

Une règle porte sur un utilisateur ou sur un badge, et prend l'un de trois
modes. C'est le même contrôle dans les deux tables du popup.

| Mode | Effet |
| ---- | ----- |
| `off` | la règle existe mais ne fait rien — permet de désactiver sans perdre le réglage |
| `white` | colore la ligne |
| `black` | empêche toute coloration de la ligne |

Le mode `black` sur un badge remplace les exclusions codées en dur de la v1
(`:not([data-a-user="fossabot"])`) : exclure le badge « Diffuseur », par exemple.

### Priorité appliquée à une ligne

1. utilisateur en `black` → aucun highlight ;
2. utilisateur en `white` → sa couleur, ou `defaultColor` s'il n'en a pas ;
3. un badge en `black` sur la ligne → aucun highlight ;
4. sinon, couleur du premier badge en `white` rencontré dans le DOM (ce qui suit
   l'ordre d'affichage de Twitch : diffuseur, modérateur, VIP, abonné…).

Une règle nominative l'emporte donc toujours sur une règle de badge, dans les
deux sens.

### Interrupteurs

- `enabled` — interrupteur maître : coupe les couleurs **et** le bouton de survol ;
- `showHoverButton` — garde les couleurs mais retire le bouton dans le chat.

### Stockage

`chrome.storage.sync` pour les réglages (partagés entre machines),
`chrome.storage.local` pour l'index des imageIds. Les migrations depuis v1
(`local.twitchUsersHighlighter`), v2 et v3 sont automatiques : les listes
`whitelisted`/`blacklisted` fusionnent en une table `users` portant un mode, les
badges v1/v2 sont classés `global`, et les couleurs choisies sont conservées.
L'index v2, qui ne portait pas la portée, est jeté et se reconstruit à la
première lecture.

## TODOLIST

### Fonctionality :

- ~~Hide button ("add to whitelist" | ...) on user message line when line isn't hovered~~
- ~~Move button ("add to whitelist" | ...) on user message line hover if following user message line is from the same user~~
- ~~Activer la fonctionnalité de highlight au chargement de la page~~
- ~~Ajouter bouton d'activation de la fonctionnalité de highlight depuis les messages de chat~~
- ~~Add button on item list (whitelist | blacklist) to switch between whitelist and blacklist~~ (colonne Mode de la table)
- ~~Add button "eye" on item list (whitelist | blacklist) to enable or disable traitement de l'user (to keep it on the list)~~ (mode `off`)
- Add button to hide whitelisted users
- Add button to hide blacklisted users

### Issues :

- ~~Style doesn't apply on badged message line with multi-word alt~~
- ~~`button-highlight-action` button doesn't go into "blacklist mode" when badged message line has multi-word alt~~

### Limites connues :

- Twitch donne un libellé distinct à chaque palier d'abonnement ("Abonné à 6
  mois", "Abonné à 12 mois"…), donc une entrée par palier dans le popup. Elles
  sont triées pour se regrouper visuellement. Les regrouper automatiquement
  demanderait le `set_id`, indisponible dans le DOM.
- Un badge n'apparaît dans le popup qu'après avoir été vu au moins une fois.
- Un badge commun à tout Twitch reste rattaché à la première chaîne où il a été
  vu tant qu'il n'a pas été rencontré sur une seconde. Il apparaît donc dans
  "This channel" avant de basculer dans "Global badges".
- `popup/bulma.min.css` et `twitch_colors.css` ne sont plus référencés.

<!-- Keep -->
img for verified badge : d12a2e27-16f6-41d0-ab77-b780518f00a3
