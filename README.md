# Bot Discord de Paris 🎲

Un bot Discord pour créer et gérer des paris avec de l'argent virtuel.

## 🚀 Installation

1. **Installez Node.js** (version 16 ou supérieure)
   - Téléchargez depuis https://nodejs.org/

2. **Installez les dépendances**
   ```bash
   npm install
   ```

3. **Configurez le bot**
   - Allez sur https://discord.com/developers/applications
   - Sélectionnez votre application bot
   - Allez dans "Bot" et copiez le TOKEN
   - Allez dans "OAuth2" et copiez le CLIENT ID
   - Ouvrez `config.json` et remplacez :
     - `VOTRE_TOKEN_ICI` par votre token
     - `VOTRE_CLIENT_ID_ICI` par votre client ID

4. **Activez les intents nécessaires**
   - Dans le portail Discord Developer, section "Bot"
   - Activez les intents suivants :
     - ✅ SERVER MEMBERS INTENT
     - ✅ MESSAGE CONTENT INTENT

5. **Invitez le bot sur votre serveur**
   - URL d'invitation : 
   ```
   https://discord.com/api/oauth2/authorize?client_id=VOTRE_CLIENT_ID&permissions=274878024768&scope=bot
   ```
   - Remplacez `VOTRE_CLIENT_ID` par votre client ID

6. **Lancez le bot**
   ```bash
   npm start
   ```

## 📖 Commandes

### Gestion du compte
- `!solde` ou `!balance` - Affiche votre solde actuel (départ : 1000€)

### Créer un pari
```
!creer-pari Qui va gagner le match ? | PSG | OM | Match nul
```
- Séparez la question et les options avec `|`
- Entre 2 et 10 options possibles
- Le bot ajoute automatiquement des emojis (1️⃣, 2️⃣, etc.)

### Parier
1. **Réagissez** avec l'emoji de votre choix sur le message du pari
2. **Répondez** au message du pari avec :
   ```
   !parier 50
   ```
   (pour parier 50€)

### Valider un pari (créateur uniquement)
```
!valider [ID_du_message] [options_gagnantes]
```
Exemples :
- `!valider 123456789 1` - L'option 1 gagne
- `!valider 123456789 1,3` - Les options 1 et 3 gagnent (plusieurs gagnants possibles)

Les gains sont distribués proportionnellement aux mises des gagnants.

### Annuler un pari (créateur uniquement)
```
!annuler [ID_du_message]
```
Tous les parieurs sont remboursés.

### Aide
```
!aide
```

## 💡 Fonctionnalités

- ✅ Solde virtuel par utilisateur (1000€ au départ)
- ✅ Création de paris avec plusieurs options
- ✅ Paris via réactions emoji
- ✅ Validation de plusieurs résultats simultanés
- ✅ Distribution proportionnelle des gains
- ✅ Sauvegarde automatique des données
- ✅ Annulation possible avec remboursement

## 📝 Exemples d'utilisation

### Exemple 1 : Match de foot
```
!creer-pari Qui gagne PSG vs OM ? | PSG | OM | Match nul
```

### Exemple 2 : Question avec plusieurs bonnes réponses
```
!creer-pari Quelles équipes seront en demi-finale ? | Real Madrid | Bayern | Man City | Arsenal
```
Validation : `!valider 123456 2,3` (si Bayern et Man City sont en demi)

### Exemple 3 : Paris simple
```
!creer-pari Il va pleuvoir demain ? | Oui | Non
```

## 🔧 Dépannage

### Le bot ne répond pas
- Vérifiez que le bot est en ligne (voyant vert sur Discord)
- Vérifiez les intents dans le Developer Portal
- Vérifiez les logs dans la console

### "Missing Permissions"
- Le bot a besoin des permissions :
  - Lire les messages
  - Envoyer des messages
  - Ajouter des réactions
  - Lire l'historique des messages

### Les réactions ne fonctionnent pas
- Vérifiez que l'intent "MESSAGE CONTENT" est activé

## 📊 Stockage des données

Les données sont sauvegardées dans :
- `bets.json` - Tous les paris actifs et résolus
- `balances.json` - Soldes de tous les utilisateurs

Ces fichiers sont créés automatiquement au premier lancement.

## ⚠️ Notes importantes

- Le créateur d'un pari ne peut pas parier dessus
- Vous pouvez modifier votre pari tant que le pari n'est pas validé
- Les gains sont calculés proportionnellement aux mises
- Si personne n'a gagné, les mises sont perdues

## 🎮 Bon jeu !
