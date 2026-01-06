const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const fs = require('fs');
const config = require('./config.json');
const express = require('express')
const app = express()
const port = process.env.PORT || 4000

app.get('/', (req, res) => {
  res.send('Hello World!')
})

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
})

// Créer le client Discord avec les intents nécessaires
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

// Stockage des paris et des soldes des utilisateurs
let bets = {}; // { messageId: { question, options: [], bettors: {} } }
let userBalances = {}; // { userId: balance }
let userStats = {}; // { userId: { totalBets, wonBets, lostBets } }

// Nom du rôle autorisé à créer des paris
const BETTING_CREATOR_ROLE = 'Créateur de Paris';

// Charger les données sauvegardées
function loadData() {
  try {
    if (fs.existsSync('./bets.json')) {
      bets = JSON.parse(fs.readFileSync('./bets.json', 'utf8'));
    }
    if (fs.existsSync('./balances.json')) {
      userBalances = JSON.parse(fs.readFileSync('./balances.json', 'utf8'));
    }
    if (fs.existsSync('./stats.json')) {
      userStats = JSON.parse(fs.readFileSync('./stats.json', 'utf8'));
    }
  } catch (error) {
    console.error('Erreur lors du chargement des données:', error);
  }
}

// Sauvegarder les données
function saveData() {
  try {
    fs.writeFileSync('./bets.json', JSON.stringify(bets, null, 2));
    fs.writeFileSync('./balances.json', JSON.stringify(userBalances, null, 2));
    fs.writeFileSync('./stats.json', JSON.stringify(userStats, null, 2));
  } catch (error) {
    console.error('Erreur lors de la sauvegarde des données:', error);
  }
}

// Obtenir ou initialiser le solde d'un utilisateur
function getBalance(userId) {
  if (!userBalances[userId]) {
    userBalances[userId] = 100; // Solde de départ : 100€
    saveData();
  }
  return userBalances[userId];
}

// Obtenir ou initialiser les stats d'un utilisateur
function getStats(userId) {
  if (!userStats[userId]) {
    userStats[userId] = {
      totalBets: 0,
      wonBets: 0,
      lostBets: 0
    };
    saveData();
  }
  return userStats[userId];
}

// Calculer le winrate d'un utilisateur
function calculateWinrate(userId) {
  const stats = getStats(userId);
  if (stats.totalBets === 0) return 0;
  return ((stats.wonBets / stats.totalBets) * 100).toFixed(1);
}

// Calculer les gains potentiels avec les cotes
function calculatePotentialWin(amount, odds) {
  return Math.floor(amount * odds);
}

// Calculer les nouvelles cotes basées sur les mises
function calculateDynamicOdds(bet) {
  const optionPools = new Array(bet.options.length).fill(0);
  
  // Calculer le total misé sur chaque option
  Object.values(bet.bettors).forEach(betData => {
    optionPools[betData.option] += betData.amount;
  });
  
  const totalPool = bet.totalPool;
  
  // Calculer les cotes pour chaque option
  return bet.options.map((opt, index) => {
    const optionPool = optionPools[index];
    if (optionPool === 0) return bet.initialOdds[index]; // Garder la cote initiale si personne n'a misé
    
    // Formule : cote = (totalPool / optionPool) * 0.95 (on garde 5% de marge)
    const dynamicOdds = (totalPool / optionPool) * 0.95;
    return Math.max(1.01, Math.min(dynamicOdds, 50)); // Limiter entre 1.01 et 50
  });
}

client.once('ready', () => {
  console.log(`✅ Bot connecté en tant que ${client.user.tag}`);
  loadData();
});

// Gestion des interactions (boutons et modals)
client.on('interactionCreate', async (interaction) => {
  // Gestion des boutons
  if (interaction.isButton()) {
    const [action, betId, ...params] = interaction.customId.split('_');

    if (action === 'bet') {
      const optionIndex = parseInt(params[0]);
      const bet = bets[betId];

      if (!bet) {
        return interaction.reply({ content: '❌ Ce pari n\'existe plus.', ephemeral: true });
      }

      if (bet.status !== 'open') {
        return interaction.reply({ content: '❌ Ce pari est fermé.', ephemeral: true });
      }

      const currentOdds = bet.initialOdds[optionIndex];
      const balance = getBalance(interaction.user.id);

      // Créer le modal pour entrer le montant
      const modal = new ModalBuilder()
        .setCustomId(`bet_modal_${betId}_${optionIndex}`)
        .setTitle(`Parier sur ${bet.options[optionIndex].name}`);

      const amountInput = new TextInputBuilder()
        .setCustomId('amount')
        .setLabel('💰 Montant à miser (en €)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Exemple: 50')
        .setRequired(true)
        .setMinLength(1)
        .setMaxLength(6);

      const row = new ActionRowBuilder().addComponents(amountInput);
      modal.addComponents(row);

      await interaction.showModal(modal);
    }

    if (action === 'validate') {
      const winningOptions = params.map(p => parseInt(p));
      const bet = bets[betId];

      if (!bet) {
        return interaction.reply({ content: '❌ Ce pari n\'existe plus.', ephemeral: true });
      }

      // Vérifier si l'utilisateur a le rôle requis
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const hasRole = member.roles.cache.some(role => role.name === BETTING_CREATOR_ROLE);

      if (!hasRole) {
        return interaction.reply({ content: `❌ Vous devez avoir le rôle **"${BETTING_CREATOR_ROLE}"** pour valider des paris.`, ephemeral: true });
      }

      // Vérifier que c'est le créateur
      if (bet.creator !== interaction.user.id) {
        return interaction.reply({ content: '❌ Seul le créateur du pari peut le valider.', ephemeral: true });
      }

      if (bet.status !== 'open') {
        return interaction.reply({ content: '❌ Ce pari a déjà été résolu.', ephemeral: true });
      }

      // Calculer les gains avec les cotes initiales
      const winners = Object.entries(bet.bettors).filter(([userId, betData]) => 
        winningOptions.includes(betData.option)
      );

      if (winners.length === 0) {
        await interaction.reply('⚠️ Aucun gagnant pour ce pari. Les mises sont perdues.');
        bet.status = 'resolved';
        saveData();
        
        // Mettre à jour l'embed
        const updatedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
          .setColor('#FF0000')
          .setTitle('📊 Pari Terminé - Aucun Gagnant');
        
        await interaction.message.edit({ embeds: [updatedEmbed], components: [] });
        return;
      }

      // Distribuer les gains selon les cotes initiales
      let distributionText = '🏆 **Résultats du pari**\n\n';
      distributionText += `Options gagnantes : ${winningOptions.map(i => bet.options[i].name).join(', ')}\n\n`;

      // Mettre à jour les stats de tous les parieurs
      Object.entries(bet.bettors).forEach(([userId, betData]) => {
        const stats = getStats(userId);
        stats.totalBets++;
        
        if (winningOptions.includes(betData.option)) {
          // Gagnant
          stats.wonBets++;
          const odds = bet.initialOdds[betData.option];
          const winnings = calculatePotentialWin(betData.amount, odds);
          const profit = winnings - betData.amount;
          
          userBalances[userId] = (userBalances[userId] || 0) + winnings;
          distributionText += `• <@${userId}> : Misé ${betData.amount}€ (cote ${odds}x) → Gagné **${winnings}€** (profit: +${profit}€)\n`;
        } else {
          // Perdant
          stats.lostBets++;
        }
      });

      bet.status = 'resolved';
      bet.winningOptions = winningOptions;
      saveData();

      // Mettre à jour l'embed
      const updatedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
        .setColor('#00FF00')
        .setTitle('📊 Pari Terminé')
        .addFields(
          { name: '✅ Résultat', value: winningOptions.map(i => `${bet.options[i].name} (${bet.initialOdds[i]}x)`).join('\n'), inline: true },
          { name: '💵 Total distribué', value: `${winners.reduce((sum, [_, betData]) => sum + calculatePotentialWin(betData.amount, bet.initialOdds[betData.option]), 0)}€`, inline: true }
        );

      await interaction.message.edit({ embeds: [updatedEmbed], components: [] });
      await interaction.reply(distributionText);
    }

    if (action === 'cancel') {
      const bet = bets[betId];

      if (!bet) {
        return interaction.reply({ content: '❌ Ce pari n\'existe plus.', ephemeral: true });
      }

      // Vérifier si l'utilisateur a le rôle requis
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const hasRole = member.roles.cache.some(role => role.name === BETTING_CREATOR_ROLE);

      if (!hasRole) {
        return interaction.reply({ content: `❌ Vous devez avoir le rôle **"${BETTING_CREATOR_ROLE}"** pour annuler des paris.`, ephemeral: true });
      }

      if (bet.creator !== interaction.user.id) {
        return interaction.reply({ content: '❌ Seul le créateur du pari peut l\'annuler.', ephemeral: true });
      }

      if (bet.status !== 'open') {
        return interaction.reply({ content: '❌ Ce pari ne peut plus être annulé.', ephemeral: true });
      }

      // Rembourser tous les parieurs
      Object.entries(bet.bettors).forEach(([userId, betData]) => {
        userBalances[userId] = (userBalances[userId] || 0) + betData.amount;
      });

      bet.status = 'cancelled';
      saveData();

      const updatedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
        .setColor('#808080')
        .setTitle('📊 Pari Annulé');

      await interaction.message.edit({ embeds: [updatedEmbed], components: [] });
      await interaction.reply('✅ Pari annulé et tous les parieurs ont été remboursés.');
    }

    if (action === 'leaderboard') {
      const sortBy = params[0];
      
      // Récupérer tous les utilisateurs avec leurs stats
      const users = Object.keys(userBalances).map(userId => ({
        userId,
        balance: getBalance(userId),
        stats: getStats(userId),
        winrate: parseFloat(calculateWinrate(userId))
      }));

      // Trier selon le critère
      let sortedUsers;
      let sortEmoji;
      let sortLabel;
      
      if (sortBy === 'winrate') {
        sortedUsers = users.sort((a, b) => b.winrate - a.winrate);
        sortEmoji = '📊';
        sortLabel = 'Winrate';
      } else {
        sortedUsers = users.sort((a, b) => b.balance - a.balance);
        sortEmoji = '💰';
        sortLabel = 'Solde';
      }

      // Limiter au top 10
      const top10 = sortedUsers.slice(0, 10);

      // Créer l'embed du classement
      let description = '';
      for (let i = 0; i < top10.length; i++) {
        const user = top10[i];
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `**${i + 1}.**`;
        description += `${medal} <@${user.userId}> — ${user.balance}€ (${user.winrate}% winrate)\n`;
      }

      const embed = new EmbedBuilder()
        .setColor('#FFD700')
        .setTitle(`🏆 Classement des Parieurs`)
        .setDescription(description || 'Aucun joueur pour le moment.')
        .addFields(
          { name: '📌 Trié par', value: `${sortEmoji} ${sortLabel}`, inline: true },
          { name: '👥 Joueurs totaux', value: `${users.length}`, inline: true }
        )
        .setFooter({ text: 'Cliquez sur les boutons pour changer le tri' })
        .setTimestamp();

      // Créer les boutons de tri
      const row = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId('leaderboard_solde')
            .setLabel('Trier par Solde')
            .setStyle(sortBy === 'solde' ? ButtonStyle.Success : ButtonStyle.Secondary)
            .setEmoji('💰'),
          new ButtonBuilder()
            .setCustomId('leaderboard_winrate')
            .setLabel('Trier par Winrate')
            .setStyle(sortBy === 'winrate' ? ButtonStyle.Success : ButtonStyle.Secondary)
            .setEmoji('📊')
        );

      await interaction.update({ embeds: [embed], components: [row] });
    }
  }

  // Gestion des modals (fenêtre de saisie)
  if (interaction.isModalSubmit()) {
    const [action, subaction, betId, optionIndex] = interaction.customId.split('_');

    if (action === 'bet' && subaction === 'modal') {
      const amount = parseInt(interaction.fields.getTextInputValue('amount'));
      const bet = bets[betId];

      if (!bet) {
        return interaction.reply({ content: '❌ Ce pari n\'existe plus.', ephemeral: true });
      }

      if (bet.status !== 'open') {
        return interaction.reply({ content: '❌ Ce pari est fermé.', ephemeral: true });
      }

      if (isNaN(amount) || amount <= 0) {
        return interaction.reply({ content: '❌ Veuillez entrer un montant valide (nombre entier positif).', ephemeral: true });
      }

      // Vérifier le solde
      const balance = getBalance(interaction.user.id);
      if (balance < amount) {
        return interaction.reply({ content: `❌ Solde insuffisant. Vous avez **${balance}€**.`, ephemeral: true });
      }

      // Si l'utilisateur a déjà parié, rembourser l'ancien pari
      if (bet.bettors[interaction.user.id]) {
        const oldBet = bet.bettors[interaction.user.id];
        userBalances[interaction.user.id] += oldBet.amount;
        bet.totalPool -= oldBet.amount;
      }

      // Placer le pari
      const optIndex = parseInt(optionIndex);
      const odds = bet.initialOdds[optIndex];
      const potentialWin = calculatePotentialWin(amount, odds);

      bet.bettors[interaction.user.id] = {
        option: optIndex,
        amount: amount,
        username: interaction.user.tag,
        odds: odds
      };
      
      userBalances[interaction.user.id] -= amount;
      bet.totalPool += amount;
      saveData();

      // Mettre à jour l'embed du pari
      try {
        const channel = await client.channels.fetch(bet.channelId);
        const betMessage = await channel.messages.fetch(betId);
        
        const bettorsCount = Object.keys(bet.bettors).length;
        
        const updatedEmbed = EmbedBuilder.from(betMessage.embeds[0])
          .setFields(
            { name: '💰 Comment parier ?', value: 'Cliquez sur le bouton de votre choix ci-dessous' },
            { name: '📈 Statut', value: '🟢 En cours', inline: true },
            { name: '💵 Total des mises', value: `${bet.totalPool}€`, inline: true },
            { name: '👥 Parieurs', value: `${bettorsCount}`, inline: true }
          );

        await betMessage.edit({ embeds: [updatedEmbed] });
      } catch (error) {
        console.error('Erreur lors de la mise à jour du message:', error);
      }

      const successEmbed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('✅ Pari Placé !')
        .setDescription(`Vous avez misé **${amount}€** sur **${bet.options[optIndex].name}**`)
        .addFields(
          { name: 'Cote', value: `${odds}x`, inline: true },
          { name: 'Gain potentiel', value: `${potentialWin}€`, inline: true },
          { name: 'Profit potentiel', value: `+${potentialWin - amount}€`, inline: true },
          { name: 'Nouveau solde', value: `${userBalances[interaction.user.id]}€` }
        );

      await interaction.reply({ embeds: [successEmbed], ephemeral: true });
    }
  }
});

client.on('messageCreate', async (message) => {
  // Ignorer les messages des bots
  if (message.author.bot) return;

  const args = message.content.split(' ');
  const command = args[0].toLowerCase();

  // Commande pour voir son solde
  if (command === '!solde' || command === '!balance') {
    const balance = getBalance(message.author.id);
    const stats = getStats(message.author.id);
    const winrate = calculateWinrate(message.author.id);
    
    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('💰 Votre Profil')
      .addFields(
        { name: '💵 Solde', value: `**${balance}€**`, inline: true },
        { name: '📊 Winrate', value: `**${winrate}%**`, inline: true },
        { name: '🎲 Paris totaux', value: `${stats.totalBets}`, inline: true },
        { name: '✅ Gagnés', value: `${stats.wonBets}`, inline: true },
        { name: '❌ Perdus', value: `${stats.lostBets}`, inline: true }
      )
      .setFooter({ text: message.author.tag })
      .setTimestamp();
    
    message.reply({ embeds: [embed] });
  }

  // Commande pour le classement
  if (command === '!classement' || command === '!leaderboard' || command === '!top') {
    // Par défaut, trier par solde
    const sortBy = args[1] || 'solde';
    
    // Récupérer tous les utilisateurs avec leurs stats
    const users = Object.keys(userBalances).map(userId => ({
      userId,
      balance: getBalance(userId),
      stats: getStats(userId),
      winrate: parseFloat(calculateWinrate(userId))
    }));

    // Trier selon le critère
    let sortedUsers;
    let sortEmoji;
    let sortLabel;
    
    if (sortBy === 'winrate') {
      sortedUsers = users.sort((a, b) => b.winrate - a.winrate);
      sortEmoji = '📊';
      sortLabel = 'Winrate';
    } else {
      sortedUsers = users.sort((a, b) => b.balance - a.balance);
      sortEmoji = '💰';
      sortLabel = 'Solde';
    }

    // Limiter au top 10
    const top10 = sortedUsers.slice(0, 10);

    // Créer l'embed du classement
    let description = '';
    for (let i = 0; i < top10.length; i++) {
      const user = top10[i];
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `**${i + 1}.**`;
      description += `${medal} <@${user.userId}> — ${user.balance}€ (${user.winrate}% winrate)\n`;
    }

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle(`🏆 Classement des Parieurs`)
      .setDescription(description || 'Aucun joueur pour le moment.')
      .addFields(
        { name: '📌 Trié par', value: `${sortEmoji} ${sortLabel}`, inline: true },
        { name: '👥 Joueurs totaux', value: `${users.length}`, inline: true }
      )
      .setFooter({ text: 'Cliquez sur les boutons pour changer le tri' })
      .setTimestamp();

    // Créer les boutons de tri
    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('leaderboard_solde')
          .setLabel('Trier par Solde')
          .setStyle(sortBy === 'solde' ? ButtonStyle.Success : ButtonStyle.Secondary)
          .setEmoji('💰'),
        new ButtonBuilder()
          .setCustomId('leaderboard_winrate')
          .setLabel('Trier par Winrate')
          .setStyle(sortBy === 'winrate' ? ButtonStyle.Success : ButtonStyle.Secondary)
          .setEmoji('📊')
      );

    message.reply({ embeds: [embed], components: [row] });
  }

  // Commande pour modifier le solde d'un joueur (ADMIN avec rôle)
  if (command === '!modifier-solde' || command === '!setbalance') {
    // Vérifier si l'utilisateur a le rôle requis
    const member = await message.guild.members.fetch(message.author.id);
    const hasRole = member.roles.cache.some(role => role.name === BETTING_CREATOR_ROLE);

    if (!hasRole) {
      return message.reply(`❌ Vous devez avoir le rôle **"${BETTING_CREATOR_ROLE}"** pour modifier les soldes.`);
    }

    // Format: !modifier-solde @user montant
    const targetUser = message.mentions.users.first();
    const amount = parseInt(args[2]);

    if (!targetUser) {
      return message.reply('❌ Vous devez mentionner un utilisateur.\nFormat: `!modifier-solde @user montant`\nExemple: `!modifier-solde @Jean 500`');
    }

    if (isNaN(amount)) {
      return message.reply('❌ Le montant doit être un nombre valide.');
    }

    const oldBalance = getBalance(targetUser.id);
    userBalances[targetUser.id] = amount;
    saveData();

    const embed = new EmbedBuilder()
      .setColor('#00FF00')
      .setTitle('✅ Solde Modifié')
      .setDescription(`Le solde de <@${targetUser.id}> a été modifié.`)
      .addFields(
        { name: 'Ancien solde', value: `${oldBalance}€`, inline: true },
        { name: 'Nouveau solde', value: `${amount}€`, inline: true },
        { name: 'Différence', value: `${amount > oldBalance ? '+' : ''}${amount - oldBalance}€`, inline: true }
      )
      .setFooter({ text: `Modifié par ${message.author.tag}` })
      .setTimestamp();

    message.reply({ embeds: [embed] });
  }

  // Commande pour créer un pari (AVEC VÉRIFICATION DU RÔLE)
  if (command === '!creer-pari' || command === '!createbet') {
    // Vérifier si l'utilisateur a le rôle requis
    const member = await message.guild.members.fetch(message.author.id);
    const hasRole = member.roles.cache.some(role => role.name === BETTING_CREATOR_ROLE);

    if (!hasRole) {
      return message.reply(`❌ Vous devez avoir le rôle **"${BETTING_CREATOR_ROLE}"** pour créer des paris.\n\n_Demandez à un administrateur de vous donner ce rôle._`);
    }

    // Format: !creer-pari Question ? | Option 1:1.5 | Option 2:2.5 | Option 3:5
    const content = message.content.slice(command.length).trim();
    
    if (!content.includes('|')) {
      return message.reply('❌ Format incorrect. Utilisez : `!creer-pari Question ? | Option 1:cote1 | Option 2:cote2`\n\nExemple: `!creer-pari Qui gagne ? | PSG:1.5 | OM:3 | Nul:4.5`');
    }

    const parts = content.split('|').map(p => p.trim());
    const question = parts[0];
    const optionsRaw = parts.slice(1);

    if (optionsRaw.length < 2 || optionsRaw.length > 10) {
      return message.reply('❌ Vous devez avoir entre 2 et 10 options.');
    }

    // Parser les options avec leurs cotes
    const options = [];
    const odds = [];

    for (const opt of optionsRaw) {
      if (!opt.includes(':')) {
        return message.reply('❌ Chaque option doit avoir une cote. Format: `Option:cote`\n\nExemple: `PSG:1.5`');
      }

      const [name, oddsStr] = opt.split(':').map(s => s.trim());
      const oddsValue = parseFloat(oddsStr);

      if (isNaN(oddsValue) || oddsValue < 1.01) {
        return message.reply(`❌ La cote pour "${name}" est invalide. Elle doit être >= 1.01`);
      }

      options.push({ name, odds: oddsValue });
      odds.push(oddsValue);
    }

    // Créer l'embed avec les cotes
    const optionsText = options.map((opt, i) => 
      `**${i + 1}.** ${opt.name} — Cote: **${opt.odds}x**`
    ).join('\n');

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('📊 Nouveau Pari')
      .setDescription(`**${question}**\n\n${optionsText}`)
      .addFields(
        { name: '💰 Comment parier ?', value: 'Cliquez sur le bouton de votre choix ci-dessous' },
        { name: '📈 Statut', value: '🟢 En cours', inline: true },
        { name: '💵 Total des mises', value: '0€', inline: true },
        { name: '👥 Parieurs', value: '0', inline: true }
      )
      .setFooter({ text: `Créé par ${message.author.tag}` })
      .setTimestamp();

    // Créer les boutons pour chaque option (max 5 par ligne)
    const rows = [];
    for (let i = 0; i < options.length; i += 5) {
      const row = new ActionRowBuilder();
      const chunk = options.slice(i, i + 5);
      
      chunk.forEach((opt, index) => {
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`bet_PLACEHOLDER_${i + index}`)
            .setLabel(`${opt.name} (${opt.odds}x)`)
            .setStyle(ButtonStyle.Primary)
            .setEmoji('💰')
        );
      });
      
      rows.push(row);
    }

    // Ajouter les boutons d'administration
    const adminRow = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`cancel_PLACEHOLDER`)
          .setLabel('Annuler le pari')
          .setStyle(ButtonStyle.Danger)
          .setEmoji('❌')
      );

    rows.push(adminRow);

    const betMessage = await message.channel.send({ embeds: [embed], components: rows });

    // Maintenant qu'on a l'ID du message, on doit recréer les boutons avec le bon ID
    const finalRows = [];
    for (let i = 0; i < options.length; i += 5) {
      const row = new ActionRowBuilder();
      const chunk = options.slice(i, i + 5);
      
      chunk.forEach((opt, index) => {
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`bet_${betMessage.id}_${i + index}`)
            .setLabel(`${opt.name} (${opt.odds}x)`)
            .setStyle(ButtonStyle.Primary)
            .setEmoji('💰')
        );
      });
      
      finalRows.push(row);
    }

    const finalAdminRow = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`cancel_${betMessage.id}`)
          .setLabel('Annuler le pari')
          .setStyle(ButtonStyle.Danger)
          .setEmoji('❌')
      );

    finalRows.push(finalAdminRow);

    // Mettre à jour le message avec les bons IDs
    await betMessage.edit({ embeds: [embed], components: finalRows });

    // Sauvegarder le pari avec l'ID du message du pari
    bets[betMessage.id] = {
      question,
      options,
      initialOdds: odds,
      bettors: {},
      creator: message.author.id,
      channelId: message.channel.id,
      totalPool: 0,
      status: 'open',
      createdAt: Date.now()
    };
    saveData();

    message.reply(`✅ Pari créé avec succès !\n🆔 ID du message : \`${betMessage.id}\`\n\n_Utilisez cet ID pour valider le pari avec_ \`!valider ${betMessage.id} [options]\``);
  }

  // Commande pour valider un pari
  if (command === '!valider' || command === '!resolve') {
    const betMessageId = args[1];
    const winningOptionsStr = args.slice(2).join(' ');

    if (!betMessageId || !winningOptionsStr) {
      return message.reply('❌ Format incorrect. Utilisez : `!valider [messageId] [numéros des options]`\nEx: `!valider 123456789 1 3` pour valider les options 1 et 3');
    }

    const bet = bets[betMessageId];

    if (!bet) {
      return message.reply('❌ Pari introuvable. Vérifiez l\'ID du message.');
    }

    // Vérifier si l'utilisateur a le rôle requis
    const member = await message.guild.members.fetch(message.author.id);
    const hasRole = member.roles.cache.some(role => role.name === BETTING_CREATOR_ROLE);

    if (!hasRole) {
      return message.reply(`❌ Vous devez avoir le rôle **"${BETTING_CREATOR_ROLE}"** pour valider des paris.`);
    }

    if (bet.creator !== message.author.id) {
      return message.reply('❌ Seul le créateur du pari peut le valider.');
    }

    if (bet.status !== 'open') {
      return message.reply('❌ Ce pari a déjà été résolu.');
    }

    // Parser les options gagnantes
    const winningOptions = winningOptionsStr.split(/[\s,]+/).map(n => parseInt(n) - 1);
    
    // Vérifier que les options sont valides
    if (winningOptions.some(opt => isNaN(opt) || opt < 0 || opt >= bet.options.length)) {
      return message.reply('❌ Numéro d\'option invalide.');
    }

    // Créer les boutons de confirmation
    const confirmRow = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`validate_${betMessageId}_${winningOptions.join('_')}`)
          .setLabel(`Confirmer : ${winningOptions.map(i => bet.options[i].name).join(', ')}`)
          .setStyle(ButtonStyle.Success)
          .setEmoji('✅')
      );

    const confirmEmbed = new EmbedBuilder()
      .setColor('#FFA500')
      .setTitle('⚠️ Confirmation de validation')
      .setDescription(`Êtes-vous sûr de vouloir valider ces options gagnantes ?\n\n${winningOptions.map(i => `• **${bet.options[i].name}** (Cote: ${bet.initialOdds[i]}x)`).join('\n')}\n\n**Cette action est irréversible.**`)
      .setFooter({ text: 'Cliquez sur le bouton pour confirmer' });

    await message.reply({ embeds: [confirmEmbed], components: [confirmRow] });
  }

  // Commande d'aide
  if (command === '!aide' || command === '!help') {
    const helpEmbed = new EmbedBuilder()
      .setColor('#0099ff')
      .setTitle('📚 Aide - Bot de Paris avec Cotes')
      .setDescription('Voici toutes les commandes disponibles :')
      .addFields(
        { name: '!solde', value: 'Affiche votre solde, winrate et statistiques' },
        { name: '!classement', value: 'Affiche le classement des joueurs\nAliases: `!leaderboard`, `!top`\nUtilisez les boutons pour trier par solde ou winrate' },
        { name: '!creer-pari', value: `**[Rôle requis: ${BETTING_CREATOR_ROLE}]**\nCrée un nouveau pari avec cotes\nFormat : \`!creer-pari Question ? | Option1:cote1 | Option2:cote2\`\nExemple: \`!creer-pari Qui gagne ? | PSG:1.5 | OM:3 | Nul:4.5\`` },
        { name: '💰 Parier', value: '**Cliquez sur le bouton** de l\'option de votre choix, puis entrez le montant dans la fenêtre qui s\'ouvre !' },
        { name: '!valider [id] [options]', value: `**[Rôle requis: ${BETTING_CREATOR_ROLE}]**\nValide un pari (créateur uniquement)\nEx: \`!valider 123456789 1 3\` pour valider les options 1 et 3` },
        { name: '!modifier-solde @user montant', value: `**[Rôle requis: ${BETTING_CREATOR_ROLE}]**\nModifie le solde d'un utilisateur\nExemple: \`!modifier-solde @Jean 500\`` },
        { name: '📊 Cotes', value: 'Chaque option a une cote qui détermine vos gains.\nGain = Mise × Cote\nExemple: 50€ × 2.5 = 125€ de gain' }
      )
      .setFooter({ text: 'Bot de Paris Discord' });

    message.reply({ embeds: [helpEmbed] });
  }
});

// Gestion des erreurs
client.on('error', console.error);

// Connexion du bot
client.login(config.token);
