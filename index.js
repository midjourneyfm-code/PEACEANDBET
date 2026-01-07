import express from 'express'; 

const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const fs = require('fs');
const config = require('./config.json');
const express = require('express');
const app = express()
const PORT = process.env.PORT; // Render définit cette variable

app.get('/', (_req, res) => res.send('Bot Discord en ligne ✅'));

app.listen(PORT, () => console.log(`Serveur web actif sur le port ${PORT}`));

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
let userHistory = {}; // { userId: [{ betId, question, option, amount, result, timestamp }] }

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
    if (fs.existsSync('./history.json')) {
      userHistory = JSON.parse(fs.readFileSync('./history.json', 'utf8'));
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
    fs.writeFileSync('./history.json', JSON.stringify(userHistory, null, 2));
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

      if (bet.status === 'locked') {
        return interaction.reply({ content: '❌ Les paris sont clôturés. Le match est en cours !', ephemeral: true });
      }

      if (bet.status !== 'open') {
        return interaction.reply({ content: '❌ Ce pari est fermé.', ephemeral: true });
      }

      // Vérifier si l'utilisateur a déjà parié
      if (bet.bettors[interaction.user.id]) {
        return interaction.reply({ content: '❌ Vous avez déjà parié sur ce match ! Vous ne pouvez parier qu\'une seule fois.', ephemeral: true });
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
        
        // Initialiser l'historique si nécessaire
        if (!userHistory[userId]) userHistory[userId] = [];
        
        if (winningOptions.includes(betData.option)) {
          // Gagnant
          stats.wonBets++;
          const odds = bet.initialOdds[betData.option];
          const winnings = calculatePotentialWin(betData.amount, odds);
          const profit = winnings - betData.amount;
          
          userBalances[userId] = (userBalances[userId] || 0) + winnings;
          distributionText += `• <@${userId}> : Misé ${betData.amount}€ (cote ${odds}x) → Gagné **${winnings}€** (profit: +${profit}€)\n`;
          
          // Ajouter à l'historique
          userHistory[userId].push({
            betId,
            question: bet.question,
            option: bet.options[betData.option].name,
            amount: betData.amount,
            winnings: winnings,
            result: 'won',
            timestamp: Date.now()
          });
        } else {
          // Perdant
          stats.lostBets++;
          
          // Ajouter à l'historique
          userHistory[userId].push({
            betId,
            question: bet.question,
            option: bet.options[betData.option].name,
            amount: betData.amount,
            winnings: 0,
            result: 'lost',
            timestamp: Date.now()
          });
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
        // Pour le winrate, filtrer ceux qui ont au moins 1 pari
        sortedUsers = users.filter(u => u.stats.totalBets > 0).sort((a, b) => {
          // Trier par winrate d'abord, puis par nombre de paris en cas d'égalité
          if (Math.abs(b.winrate - a.winrate) > 0.01) { // Epsilon pour comparaison de floats
            return b.winrate - a.winrate;
          }
          return b.stats.totalBets - a.stats.totalBets;
        });
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
        description += `${medal} <@${user.userId}> — ${user.balance}€ (${user.winrate}% winrate, ${user.stats.totalBets} paris)\n`;
      }

      if (description === '') {
        description = 'Aucun joueur avec des paris pour le moment.';
      }

      const embed = new EmbedBuilder()
        .setColor('#FFD700')
        .setTitle(`🏆 Classement des Parieurs`)
        .setDescription(description)
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

      if (bet.status === 'locked') {
        return interaction.reply({ content: '❌ Les paris sont clôturés. Le match est en cours !', ephemeral: true });
      }

      if (bet.status !== 'open') {
        return interaction.reply({ content: '❌ Ce pari est fermé.', ephemeral: true });
      }

      if (isNaN(amount) || amount <= 0) {
        return interaction.reply({ content: '❌ Veuillez entrer un montant valide (nombre entier positif).', ephemeral: true });
      }

      // Vérifier si l'utilisateur a déjà parié (double sécurité)
      if (bet.bettors[interaction.user.id]) {
        return interaction.reply({ content: '❌ Vous avez déjà parié sur ce match ! Vous ne pouvez parier qu\'une seule fois.', ephemeral: true });
      }

      // Vérifier le solde
      const balance = getBalance(interaction.user.id);
      if (balance < amount) {
        return interaction.reply({ content: `❌ Solde insuffisant. Vous avez **${balance}€**.`, ephemeral: true });
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
            betMessage.embeds[0].fields.filter(f => !['📈 Statut', '💵 Total des mises', '👥 Parieurs'].includes(f.name)).concat([
              { name: '💰 Comment parier ?', value: 'Cliquez sur le bouton de votre choix ci-dessous' },
              { name: '📈 Statut', value: '🟢 En cours', inline: true },
              { name: '💵 Total des mises', value: `${bet.totalPool}€`, inline: true },
              { name: '👥 Parieurs', value: `${bettorsCount}`, inline: true }
            ])
          );

        await betMessage.edit({ embeds: [updatedEmbed] });
        
        // Annonce publique du pari
        await betMessage.reply(`💰 **<@${interaction.user.id}>** a parié **${amount}€** sur **${bet.options[optIndex].name}** (cote ${odds}x) — Gain potentiel : **${potentialWin}€**`);
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
      // Pour le winrate, filtrer ceux qui ont au moins 1 pari
      sortedUsers = users.filter(u => u.stats.totalBets > 0).sort((a, b) => {
        // Trier par winrate d'abord, puis par nombre de paris en cas d'égalité
        if (b.winrate !== a.winrate) {
          return b.winrate - a.winrate;
        }
        return b.stats.totalBets - a.stats.totalBets;
      });
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
      description += `${medal} <@${user.userId}> — ${user.balance}€ (${user.winrate}% winrate, ${user.stats.totalBets} paris)\n`;
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

  // Commande pour voir les paris en cours
  if (command === '!paris') {
    const activeBets = Object.entries(bets).filter(([id, bet]) => bet.status === 'open' || bet.status === 'locked');

    if (activeBets.length === 0) {
      return message.reply('📭 Aucun pari en cours pour le moment.');
    }

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('📊 Paris En Cours')
      .setDescription(`Il y a actuellement **${activeBets.length}** pari(s) actif(s) :\n\n`)
      .setTimestamp();

    for (const [betId, bet] of activeBets) {
      const statusEmoji = bet.status === 'locked' ? '🔒' : '🟢';
      const statusText = bet.status === 'locked' ? 'Clôturé' : 'Ouvert';
      const bettorsCount = Object.keys(bet.bettors).length;
      
      // Lister les options avec leurs numéros pour faciliter la validation
      const optionsList = bet.options.map((opt, i) => `${i + 1}. ${opt.name} (${bet.initialOdds[i]}x)`).join(', ');
      
      let fieldValue = `**ID:** \`${betId}\`\n**Statut:** ${statusEmoji} ${statusText}\n**Options:** ${optionsList}\n**Parieurs:** ${bettorsCount}\n**Cagnotte:** ${bet.totalPool}€`;
      
      if (bet.closingTime) {
        fieldValue += `\n**Clôture:** <t:${Math.floor(bet.closingTime / 1000)}:R>`;
      }
      
      fieldValue += `\n\n💡 _Pour valider : \`!valider ${betId} [numéros]\`_`;
      
      embed.addFields({
        name: bet.question,
        value: fieldValue,
        inline: false
      });
    }

    message.reply({ embeds: [embed] });
  }

  // Commande pour voir le profil d'un membre
  if (command === '!profil' || command === '!profile' || command === '!stats') {
    const targetUser = message.mentions.users.first() || message.author;
    const balance = getBalance(targetUser.id);
    const stats = getStats(targetUser.id);
    const winrate = calculateWinrate(targetUser.id);
    
    // Récupérer l'historique
    const history = userHistory[targetUser.id] || [];
    const recentHistory = history.slice(-5).reverse(); // 5 derniers paris

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle(`📊 Profil de ${targetUser.username}`)
      .setThumbnail(targetUser.displayAvatarURL())
      .addFields(
        { name: '💵 Solde', value: `**${balance}€**`, inline: true },
        { name: '📊 Winrate', value: `**${winrate}%**`, inline: true },
        { name: '🎲 Paris totaux', value: `${stats.totalBets}`, inline: true },
        { name: '✅ Gagnés', value: `${stats.wonBets}`, inline: true },
        { name: '❌ Perdus', value: `${stats.lostBets}`, inline: true },
        { name: '⚖️ Ratio', value: `${stats.wonBets}/${stats.lostBets}`, inline: true }
      )
      .setTimestamp();

    // Ajouter l'historique récent si disponible
    if (recentHistory.length > 0) {
      let historyText = '';
      for (const h of recentHistory) {
        const resultEmoji = h.result === 'won' ? '✅' : '❌';
        const profit = h.result === 'won' ? `+${h.winnings - h.amount}€` : `-${h.amount}€`;
        historyText += `${resultEmoji} **${h.question}** — ${h.option} (${h.amount}€) ${profit}\n`;
      }
      embed.addFields({ name: '📜 Historique Récent', value: historyText || 'Aucun historique', inline: false });
    }

    message.reply({ embeds: [embed] });
  }

  // Commande pour faire un don
  if (command === '!don' || command === '!give') {
    const targetUser = message.mentions.users.first();
    const amount = parseInt(args[2]);

    if (!targetUser) {
      return message.reply('❌ Vous devez mentionner un utilisateur.\nFormat: `!don @user montant`\nExemple: `!don @Jean 50`');
    }

    if (targetUser.id === message.author.id) {
      return message.reply('❌ Vous ne pouvez pas vous faire un don à vous-même !');
    }

    if (targetUser.bot) {
      return message.reply('❌ Vous ne pouvez pas faire de don à un bot !');
    }

    if (isNaN(amount) || amount <= 0) {
      return message.reply('❌ Le montant doit être un nombre positif valide.');
    }

    const balance = getBalance(message.author.id);
    if (balance < amount) {
      return message.reply(`❌ Solde insuffisant. Vous avez **${balance}€**.`);
    }

    // Effectuer le transfert
    userBalances[message.author.id] -= amount;
    userBalances[targetUser.id] = (userBalances[targetUser.id] || 0) + amount;
    saveData();

    const embed = new EmbedBuilder()
      .setColor('#00FF00')
      .setTitle('🎁 Don Effectué')
      .setDescription(`<@${message.author.id}> a fait un don de **${amount}€** à <@${targetUser.id}> !`)
      .addFields(
        { name: 'Donateur', value: `<@${message.author.id}>\nNouveau solde : ${userBalances[message.author.id]}€`, inline: true },
        { name: 'Bénéficiaire', value: `<@${targetUser.id}>\nNouveau solde : ${getBalance(targetUser.id)}€`, inline: true }
      )
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

    // Format: !creer-pari Question ? | Option 1:1.5 | Option 2:2.5 | Option 3:5 | 2h30
    const content = message.content.slice(command.length).trim();
    
    if (!content.includes('|')) {
      return message.reply('❌ Format incorrect. Utilisez : `!creer-pari Question ? | Option 1:cote1 | Option 2:cote2 | durée`\n\nExemple: `!creer-pari Qui gagne ? | PSG:1.5 | OM:3 | Nul:4.5 | 2h30`\nDurée optionnelle (ex: 1h, 30m, 2h30)');
    }

    const parts = content.split('|').map(p => p.trim());
    const question = parts[0];
    
    // La dernière partie peut être soit une option, soit une heure de clôture
    let closingTimeStr = null;
    let optionsRaw = parts.slice(1);
    
    // Vérifier si la dernière partie est une heure (format: 21h30, 14h00, etc)
    const lastPart = parts[parts.length - 1];
    if (/^\d{1,2}h\d{0,2}$/i.test(lastPart.trim())) {
      closingTimeStr = lastPart;
      optionsRaw = parts.slice(1, -1);
    }

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

    // Calculer l'heure de clôture (heure absolue française - Europe/Paris)
    let closingTime = null;
    let closingTimestamp = null;
    
    if (closingTimeStr) {
      const hoursMatch = closingTimeStr.match(/(\d{1,2})h/i);
      const minutesMatch = closingTimeStr.match(/h(\d{2})/i);
      
      if (hoursMatch) {
        const targetHour = parseInt(hoursMatch[1]);
        const targetMinute = minutesMatch ? parseInt(minutesMatch[1]) : 0;
        
        if (targetHour >= 0 && targetHour < 24 && targetMinute >= 0 && targetMinute < 60) {
          // Créer une date pour aujourd'hui à l'heure cible (heure française UTC+1/+2)
          const now = new Date();
          const closingDate = new Date(now);
          closingDate.setHours(targetHour, targetMinute, 0, 0);
          
          // Ajuster pour le fuseau horaire français (UTC+1 en hiver, UTC+2 en été)
          // On calcule l'offset actuel
          const offset = closingDate.getTimezoneOffset(); // Minutes de différence avec UTC
          const parisOffset = -60; // Paris est UTC+1 (ou -60 minutes par rapport à UTC)
          
          // Si l'heure est déjà passée aujourd'hui, on prend demain
          if (closingDate.getTime() <= now.getTime()) {
            closingDate.setDate(closingDate.getDate() + 1);
          }
          
          closingTimestamp = closingDate.getTime();
          closingTime = closingDate;
        } else {
          return message.reply('❌ Heure invalide. Format: `21h30` (heure entre 0 et 23, minutes entre 0 et 59)');
        }
      }
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

    // Ajouter l'heure de clôture si définie
    if (closingTime) {
      embed.addFields({
        name: '⏰ Clôture des paris',
        value: `<t:${Math.floor(closingTimestamp / 1000)}:R> (<t:${Math.floor(closingTimestamp / 1000)}:f>)`,
        inline: false
      });
    }

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
      createdAt: Date.now(),
      closingTime: closingTimestamp,
      reminderSent: false
    };
    saveData();

    let replyText = `✅ Pari créé avec succès !\n🆔 ID du message : \`${betMessage.id}\`\n\n_Utilisez cet ID pour valider le pari avec_ \`!valider ${betMessage.id} [options]\``;
    
    if (closingTime) {
      replyText += `\n\n⏰ Les paris seront automatiquement clôturés à **${closingTime.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' })}** (<t:${Math.floor(closingTimestamp / 1000)}:R>)`;
      
      // Programmer la clôture automatique
      const timeUntilClosing = closingTimestamp - Date.now();
      if (timeUntilClosing > 0) {
        setTimeout(async () => {
          const bet = bets[betMessage.id];
          if (bet && bet.status === 'open') {
            bet.status = 'locked';
            saveData();
            
            try {
              const channel = await client.channels.fetch(bet.channelId);
              const msg = await channel.messages.fetch(betMessage.id);
              
              const lockedEmbed = EmbedBuilder.from(msg.embeds[0])
                .setColor('#FFA500')
                .setFields(
                  msg.embeds[0].fields.filter(f => f.name !== '📈 Statut').concat([
                    { name: '📈 Statut', value: '🔒 Clôturé (en attente de validation)', inline: true },
                    { name: '💵 Total des mises', value: `${bet.totalPool}€`, inline: true },
                    { name: '👥 Parieurs', value: `${Object.keys(bet.bettors).length}`, inline: true }
                  ])
                );
              
              // Retirer les boutons de paris
              const lockedRows = msg.components.slice(-1); // Garder seulement le bouton admin
              await msg.edit({ embeds: [lockedEmbed], components: lockedRows });
              
              await msg.reply('🔒 **Les paris sont maintenant clôturés !** Le match est en cours. En attente de validation du résultat...');
            } catch (error) {
              console.error('Erreur lors de la clôture automatique:', error);
            }
          }
        }, timeUntilClosing);
        
        // Programmer le rappel 1h avant
        const oneHourBefore = timeUntilClosing - (60 * 60 * 1000);
        if (oneHourBefore > 0) {
          setTimeout(async () => {
            const bet = bets[betMessage.id];
            if (bet && bet.status === 'open' && !bet.reminderSent) {
              bet.reminderSent = true;
              saveData();
              
              try {
                const channel = await client.channels.fetch(bet.channelId);
                const msg = await channel.messages.fetch(betMessage.id);
                await msg.reply('⏰ **Rappel** : Plus qu\'**1 heure** avant la clôture des paris ! Placez vos mises maintenant !');
              } catch (error) {
                console.error('Erreur lors de l\'envoi du rappel:', error);
              }
            }
          }, oneHourBefore);
        }
      }
    }
    
    message.reply(replyText);
  }

  // Commande pour créer un PARI BOOSTÉ (PEACE & BOOST)
  if (command === '!boost') {
    // Vérifier si l'utilisateur a le rôle requis
    const member = await message.guild.members.fetch(message.author.id);
    const hasRole = member.roles.cache.some(role => role.name === BETTING_CREATOR_ROLE);

    if (!hasRole) {
      return message.reply(`❌ Vous devez avoir le rôle **"${BETTING_CREATOR_ROLE}"** pour créer des paris boostés.\n\n_Demandez à un administrateur de vous donner ce rôle._`);
    }

    // Format: !boost Nom de l'event | 5.5 | 21h30
    const content = message.content.slice(command.length).trim();
    
    if (!content.includes('|')) {
      return message.reply('❌ Format incorrect. Utilisez : `!boost Nom de l\'event | cote | heure`\n\nExemple: `!boost Victoire du PSG | 5.5 | 21h30`');
    }

    const parts = content.split('|').map(p => p.trim());
    
    if (parts.length < 2 || parts.length > 3) {
      return message.reply('❌ Format incorrect. Utilisez : `!boost Nom de l\'event | cote | heure`');
    }

    const eventName = parts[0];
    const oddsValue = parseFloat(parts[1]);
    const closingTimeStr = parts[2] || null;

    if (isNaN(oddsValue) || oddsValue < 1.01) {
      return message.reply(`❌ La cote est invalide. Elle doit être >= 1.01`);
    }

    // Calculer l'heure de clôture si fournie
    let closingTime = null;
    let closingTimestamp = null;
    
    if (closingTimeStr) {
      const hoursMatch = closingTimeStr.match(/(\d{1,2})h/i);
      const minutesMatch = closingTimeStr.match(/h(\d{2})/i);
      
      if (hoursMatch) {
        const targetHour = parseInt(hoursMatch[1]);
        const targetMinute = minutesMatch ? parseInt(minutesMatch[1]) : 0;
        
        if (targetHour >= 0 && targetHour < 24 && targetMinute >= 0 && targetMinute < 60) {
          const now = new Date();
          const closingDate = new Date(now);
          closingDate.setHours(targetHour, targetMinute, 0, 0);
          
          if (closingDate.getTime() <= now.getTime()) {
            closingDate.setDate(closingDate.getDate() + 1);
          }
          
          closingTimestamp = closingDate.getTime();
          closingTime = closingDate;
        }
      }
    }

    // Créer l'embed ultra-visuel pour le BOOST
    const embed = new EmbedBuilder()
      .setColor('#FF00FF') // Magenta/Rose flashy
      .setTitle('⚡💎 PEACE & BOOST 💎⚡')
      .setDescription(`
╔════════════════════════════════╗
║                                                              ║
║    🔥 **${eventName}** 🔥    ║
║                                                              ║
║         **COTE BOOSTÉE: ${oddsValue}x**         ║
║                                                              ║
╚════════════════════════════════╝

💰 **Pari à risque, récompense maximale !**
🚀 **Une seule option, tout ou rien !**
⚡ **Tentez votre chance maintenant !**
`)
      .addFields(
        { name: '🎯 Option', value: `**${eventName}**`, inline: true },
        { name: '💎 Cote', value: `**${oddsValue}x**`, inline: true },
        { name: '📈 Statut', value: '🟢 **EN COURS**', inline: true },
        { name: '💵 Total des mises', value: '0€', inline: true },
        { name: '👥 Parieurs', value: '0', inline: true },
        { name: '⚡', value: '⚡', inline: true }
      )
      .setFooter({ text: `🔥 PARI BOOSTÉ par ${message.author.tag} 🔥` })
      .setTimestamp()
      .setImage('https://media.tenor.com/images/f9c2f573e7c56c6be8b23b6e51e45e5a/tenor.gif'); // GIF flashy (optionnel)

    if (closingTime) {
      embed.addFields({
        name: '⏰ Clôture',
        value: `<t:${Math.floor(closingTimestamp / 1000)}:R> (**${closingTime.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' })}**)`,
        inline: false
      });
    }

    // Créer le bouton ultra-visible
    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`bet_PLACEHOLDER_0`)
          .setLabel(`🔥 PARIER SUR ${eventName.toUpperCase()} (${oddsValue}x) 🔥`)
          .setStyle(ButtonStyle.Danger) // Rouge pour attirer l'attention
          .setEmoji('💎')
      );

    const adminRow = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`cancel_PLACEHOLDER`)
          .setLabel('Annuler le pari')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji('❌')
      );

    const betMessage = await message.channel.send({ embeds: [embed], components: [row, adminRow] });

    // Mettre à jour avec les bons IDs
    const finalRow = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`bet_${betMessage.id}_0`)
          .setLabel(`🔥 PARIER SUR ${eventName.toUpperCase()} (${oddsValue}x) 🔥`)
          .setStyle(ButtonStyle.Danger)
          .setEmoji('💎')
      );

    const finalAdminRow = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`cancel_${betMessage.id}`)
          .setLabel('Annuler le pari')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji('❌')
      );

    await betMessage.edit({ embeds: [embed], components: [finalRow, finalAdminRow] });

    // Sauvegarder le pari boosté
    bets[betMessage.id] = {
      question: `⚡ BOOST: ${eventName}`,
      options: [{ name: eventName, odds: oddsValue }],
      initialOdds: [oddsValue],
      bettors: {},
      creator: message.author.id,
      channelId: message.channel.id,
      totalPool: 0,
      status: 'open',
      createdAt: Date.now(),
      closingTime: closingTimestamp,
      reminderSent: false,
      isBoosted: true // Marquer comme boosté
    };
    saveData();

    let replyText = `⚡💎 **PARI BOOSTÉ CRÉÉ !** 💎⚡\n🆔 ID : \`${betMessage.id}\`\n\n_Validez avec_ \`!valider ${betMessage.id} 1\` _(si gagné)_`;
    
    if (closingTime) {
      replyText += `\n\n⏰ Clôture automatique à **${closingTime.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' })}**`;
      
      // Programmer la clôture (même logique que pour les paris normaux)
      const timeUntilClosing = closingTimestamp - Date.now();
      if (timeUntilClosing > 0) {
        setTimeout(async () => {
          const bet = bets[betMessage.id];
          if (bet && bet.status === 'open') {
            bet.status = 'locked';
            saveData();
            
            try {
              const channel = await client.channels.fetch(bet.channelId);
              const msg = await channel.messages.fetch(betMessage.id);
              
              const lockedEmbed = EmbedBuilder.from(msg.embeds[0])
                .setColor('#FFA500');
              
              await msg.edit({ embeds: [lockedEmbed], components: [finalAdminRow] });
              await msg.reply('🔒 **PARI BOOSTÉ CLÔTURÉ !** En attente du résultat...');
            } catch (error) {
              console.error('Erreur lors de la clôture:', error);
            }
          }
        }, timeUntilClosing);
        
        // Rappel 1h avant
        const oneHourBefore = timeUntilClosing - (60 * 60 * 1000);
        if (oneHourBefore > 0) {
          setTimeout(async () => {
            const bet = bets[betMessage.id];
            if (bet && bet.status === 'open' && !bet.reminderSent) {
              bet.reminderSent = true;
              saveData();
              
              try {
                const channel = await client.channels.fetch(bet.channelId);
                const msg = await channel.messages.fetch(betMessage.id);
                await msg.reply('⏰🔥 **DERNIÈRE HEURE POUR LE BOOST !** Ne ratez pas cette cote exceptionnelle !');
              } catch (error) {
                console.error('Erreur rappel:', error);
              }
            }
          }, oneHourBefore);
        }
      }
    }
    
    message.reply(replyText);
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
        { name: '👤 Commandes Utilisateur', value: '\u200b', inline: false },
        { name: '!solde', value: 'Affiche votre solde, winrate et statistiques' },
        { name: '!classement', value: 'Classement des joueurs (cliquez pour trier par solde ou winrate)' },
        { name: '!profil [@user]', value: 'Affiche le profil complet avec historique des 5 derniers paris' },
        { name: '!paris', value: 'Liste tous les paris actifs avec ID et options pour valider' },
        { name: '!don @user montant', value: 'Faire un don à un autre joueur\nExemple: `!don @Jean 50`' },
        { name: '💰 Parier', value: 'Cliquez sur le bouton, entrez le montant dans la fenêtre\n**⚠️ UN SEUL PARI par match !**' },
        { name: '⚙️ Commandes Admin', value: `(Rôle requis: **${BETTING_CREATOR_ROLE}**)`, inline: false },
        { name: '!creer-pari', value: 'Format : `!creer-pari Question ? | Option1:cote1 | Option2:cote2 | heure`\nExemple: `!creer-pari Qui gagne ? | PSG:1.5 | OM:3 | 21h30`\nHeure optionnelle = heure de clôture (format 24h)' },
        { name: '!boost', value: '⚡💎 **PARI SPÉCIAL BOOSTÉ** 💎⚡\nFormat: `!boost Nom de l\'event | cote | heure`\nExemple: `!boost Victoire PSG | 5.5 | 21h30`\nUne seule option, cote élevée, visuel attractif !' },
        { name: '!valider [id] [options]', value: 'Valide un pari\nEx: `!valider 123456789 1 3`' },
        { name: '!modifier-solde @user montant', value: 'Modifie le solde d\'un utilisateur\nEx: `!modifier-solde @Jean 500`' },
        { name: '⏰ Clôture automatique', value: 'Heure absolue (ex: 21h30 = clôture à 21h30)\nRappel automatique 1h avant\nPari reste ouvert pour validation après clôture' },
        { name: '📊 Cotes', value: 'Gain = Mise × Cote\nExemple: 50€ × 2.5 = 125€ de gain' }
      )
      .setFooter({ text: 'Bot de Paris Discord' });

    message.reply({ embeds: [helpEmbed] });
  }
});

// Gestion des erreurs
client.on('error', console.error);

// Connexion du bot
client.login(config.token);
