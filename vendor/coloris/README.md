# Coloris (vendoré)

Sélecteur de couleur utilisé par le popup. Copié tel quel, sans build ni
dépendance.

| | |
| --- | --- |
| Source | https://github.com/mdbassit/Coloris |
| Version | 0.25.0 |
| Licence | MIT (voir [LICENSE](LICENSE)) |
| Fichiers | `src/coloris.js` et `src/coloris.css` du dépôt, non minifiés |

**Pourquoi vendoré** : la CSP du manifest v3 interdit tout script distant, donc
pas de CDN. Ce sont les sources non minifiées qui sont copiées, et non le
`dist/`, pour qu'une revue (AMO) puisse lire le code tel quel.

**Pourquoi cette lib** : le sélecteur natif de `input[type="color"]` s'ouvre sous
Firefox dans une fenêtre extérieure au popup, qui perd le focus et se ferme —
la couleur choisie est alors perdue. Coloris dessine son panneau dans le
document du popup. Voir la section « Choix d'une couleur » du README racine.

**Ne pas modifier ces fichiers.** Pour mettre à jour : recopier les deux sources
depuis le dépôt amont et vérifier le tableau ci-dessus. Les retouches de style
propres au popup (fonds sombres alignés sur ceux de l'extension) sont dans
`popup/popup.css`, sous `#clr-picker`.
