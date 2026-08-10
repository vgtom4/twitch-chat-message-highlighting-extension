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

Aucune API Twitch, aucun Client-Id, aucun OAuth : les badges sont reconnus en
lisant le chat.

**Rien n'est enregistré tant que l'utilisateur n'a pas choisi.** Les badges
croisés dans le chat vivent en mémoire dans le content script, le temps de la
session. Le popup vient les lire par message et les affiche en bande sous
« Seen in this chat » ; **c'est le clic sur une icône qui crée la règle**, en
mise en avant d'emblée. Le storage ne contient donc que ce qui sert vraiment.

Une règle porte elle-même ses `imageIds` : c'est ce qui l'identifie face au DOM.
Il n'y a plus d'index séparé. Une règle issue d'une migration n'a pas encore
d'imageId — elle est reconnue une fois par son libellé, puis reçoit l'imageId et
l'utilise ensuite.

Si l'utilisateur change la langue de Twitch, l'imageId reste connu : seul le
libellé affiché est mis à jour, sans créer de doublon.

### Badges ignorés

`IGNORED_BADGE_IDS` dans [shared.js](shared.js) liste des imageIds à ne jamais
traiter : ni proposés dans le popup, ni pris en compte pour colorer une ligne. Y
figurent les badges de prédiction (les deux issues), qui indiquent le vote de
l'auteur du message et non ce qu'il est.

La purge se rejoue à **chaque** chargement, pas au fil d'une migration : ajouter
un identifiant à la liste suffit à retirer ce qui figure déjà dans les règles,
sans nouvelle version de schéma. Une règle qui garde au moins un imageId légitime
est conservée, allégée de l'imageId ignoré.

### Portée d'un badge

Un badge appartient à l'une de trois portées, et sa clé est
`${portée}|${libellé normalisé}` :

| Portée | Contenu | Y entre |
| ------ | ------- | ------- |
| `<chaîne>` | badges propres à un streamer : paliers d'abonnement, badges custom | à la création de la règle |
| `event` | badges vus sur plus d'une chaîne : campagnes, drops, non triés | automatiquement |
| `global` | badges permanents de Twitch : vérifié, prime, modérateur, VIP… | **manuellement uniquement** |
| `?` | chaîne non identifiable (certaines pages de VOD) | à la création de la règle |

La classification automatique est déduite de l'observation, sans API : **un
imageId vu sur deux chaînes différentes n'est pas un badge de streamer** et passe
en `event`. Un badge qui n'apparaît que sur une chaîne lui reste attaché, avec sa
propre couleur — l'« Abonné à 6 mois » de deux streamers sont deux entrées
distinctes.

`global` est un classement **manuel** : rien n'y entre tout seul, et rien n'en
sort tout seul. C'est là qu'on range les badges permanents, une fois pour toutes.
Un badge déjà en `global` ou en `event` n'est plus reclassé par l'observation.

Une règle créée alors que la chaîne est indéterminée prend la portée `?`, puis
est rattachée à la chaîne dès qu'elle est identifiée.

Chaque badge mémorise son `origin`, la chaîne où la règle a été créée, pour
pouvoir défaire un déplacement manuel.

Le popup range les badges en quatre `<details>` : la chaîne affichée (déplié),
`event`, `global`, et les autres chaînes (replié, groupé par chaîne). La colonne
**Move** porte deux bascules, `E` et `G` : un clic déplace, recliquer sur la
liste courante renvoie le badge à sa chaîne d'origine. Si une entrée existe déjà
à destination sous le même libellé, les deux fusionnent.

Le popup obtient le nom de la chaîne **et les badges croisés dans ce chat** en
interrogeant le content script de l'onglet actif (message `tch:getState`) — pas
via une valeur partagée dans le storage, qui serait fausse avec plusieurs onglets
Twitch ouverts, et qui supposerait d'enregistrer ces badges.

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

- `enabled` — interrupteur maître, visible en haut du popup : coupe les couleurs
  **et** le bouton de survol ;
- `showHoverButton` — garde les couleurs mais retire le bouton dans le chat.

### Panneau de réglages

Le bouton engrenage déplie les réglages secondaires (`showHoverButton`, couleur
par défaut) et une zone de reset : supprimer toutes les règles de badge, tous les
utilisateurs, ou tout remettre à zéro. Chaque reset demande un second clic de
confirmation, qui expire au bout de 4 s — plutôt qu'un `confirm()`, qui ferme le
popup sur certaines plateformes.

Les badges dont la règle est supprimée retournent dans « Seen in this chat » et
peuvent être repris d'un clic, mais leur couleur est perdue.

### Stockage

Tout tient dans `chrome.storage.sync` (partagé entre machines), sous une clé
unique. `chrome.storage.local` n'est plus lu que pour les migrations.

Les migrations depuis v1 (`local.twitchUsersHighlighter`) à v5 sont automatiques :
les listes `whitelisted`/`blacklisted` fusionnent en une table `users` portant un
mode, les badges v1/v2 sont classés `global`, l'ancien index `tchBadgeIndex` est
replié dans les `imageIds` des règles puis supprimé, et les couleurs choisies sont
conservées.

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
- Un badge n'est proposé qu'après avoir été vu au moins une fois dans le chat de
  l'onglet ouvert, et la liste des badges vus est perdue au rechargement de la
  page. Elle se reconstitue en quelques messages.
- Une règle de badge reste rattachée à la chaîne où elle a été créée tant que son
  imageId n'a pas été rencontré sur une seconde chaîne. Un badge permanent de
  Twitch apparaît donc dans "This channel", puis bascule dans "Event badges", d'où
  on le promeut manuellement en "Global badges".
- Une règle migrée depuis la v1/v2 n'a pas de chaîne d'origine connue : annuler
  son déplacement la renvoie en portée `?`, donc dans "Other channels".
- Le popup et les onglets écrivent la même clé de storage sans verrou : le dernier
  écrivain gagne. Les onglets n'écrivent plus qu'à l'occasion (libellé qui suit la
  langue, imageId rattaché, changement de portée), ce qui rend la collision rare
  et sans conséquence durable.
  **Corollaire pour le code du popup** : aucun `await` ne doit séparer une
  mutation de `settings` de son enregistrement, sinon `onChanged` remplace
  `settings` entre les deux et le changement est perdu. La suite `flow` vérifie
  cet invariant sur `moveBadge`, `adoptBadge` et `addUser`.
- `popup/bulma.min.css` et `twitch_colors.css` ne sont plus référencés.

<!-- Keep -->
img for verified badge : d12a2e27-16f6-41d0-ab77-b780518f00a3
