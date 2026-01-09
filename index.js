const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const config = require('./config.json');
const express = require('express');
const mongoose = require('mongoose');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;

app.get('/', (_req, res) => res.send('Bot Discord en ligne ✅'));
app.listen(PORT, () => console.log(`Serveur web actif sur le port ${PORT}`));

// Connexion MongoDB
mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('MongoDB connecté ✅'))
  .catch(err => console.error('Erreur MongoDB:', err));

// ==================== SCHEMAS MONGODB ====================

const userSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  balance: { type: Number, default: 100 },
  stats: {
    totalBets: { type: Number, default: 0 },
    wonBets: { type: Number, default: 0 },
    lostBets: { type: Number, default: 0 }
  },
  history: [{
    betId: String,
    question: String,
    option: String,
    amount: Number,
    winnings: Number,
    result: String,
    timestamp: Date
  }]
});

const betSchema = new mongoose.Schema({
  messageId: { type: String, required: true, unique: true },
  question: String,
  options: [{ name: String, odds: Number }],
  initialOdds: [Number],
  bettors: mongoose.Schema.Types.Mixed,
  creator: String,
  channelId: String,
  totalPool: { type: Number, default: 0 },
  status: { type: String, default: 'open' },
  createdAt: { type: Date, default: Date.now },
  closingTime: Date,
  reminderSent: { type: Boolean, default: false },
  isBoosted: { type: Boolean, default: false },
  winningOptions: [Number]
});

const User = mongoose.model('User', userSchema);
const Bet = mongoose.model('Bet', betSchema);

const combiSchema = new mongoose.Schema({
  combiId: { type: String, required: true, unique: true },
  userId: { type: String, required: true },
  username: String,
  bets: [{
    betId: String,
    messageId: String,
    question: String,
    optionIndex: Number,
    optionName: String,
    odds: Number,
    amount: Number
  }],
  totalOdds: Number,
  totalStake: Number,
  potentialWin: Number,
  status: { type: String, default: 'pending' }, // pending, confirmed, won, lost, cancelled
  createdAt: { type: Date, default: Date.now },
  resolvedBets: { type: Number, default: 0 }
});

const Combi = mongoose.model('Combi', combiSchema);

// ==================== CLIENT DISCORD ====================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

const BETTING_CREATOR_ROLE = 'Créateur de Paris';
const tempCombis = new Map(); // userId -> { bets: [], totalOdds: 1 }

// ==================== FONCTIONS UTILITAIRES ====================

async function getUser(userId) {
  let user = await User.findOne({ userId });
  if (!user) {
    user = new User({ userId, balance: 100 });
    await user.save();
  }
  return user;
}

async function getBalance(userId) {
  const user = await getUser(userId);
  return user.balance;
}

async function getStats(userId) {
  const user = await getUser(userId);
  return user.stats;
}

async function calculateWinrate(userId) {
  const stats = await getStats(userId);
  if (stats.totalBets === 0) return 0;
  return ((stats.wonBets / stats.totalBets) * 100).toFixed(1);
}

function calculatePotentialWin(amount, odds) {
  return Math.floor(amount * odds);
}

async function closeBetAutomatically(messageId) {
  try {
    const bet = await Bet.findOne({ messageId });
    if (!bet || bet.status !== 'open') return;
    
    bet.status = 'locked';
    await bet.save();
    
    const channel = await client.channels.fetch(bet.channelId);
    const msg = await channel.messages.fetch(messageId);
    
    const lockedEmbed = EmbedBuilder.from(msg.embeds[0]).setColor('#FFA500');
    const fields = msg.embeds[0].fields.filter(f => !['📈 Statut', '💵 Total des mises', '👥 Parieurs'].includes(f.name));
    const bettorsCount = bet.bettors ? Object.keys(bet.bettors).length : 0;
    fields.push(
      { name: '📈 Statut', value: '🔒 Clôturé (en attente de validation)', inline: true },
      { name: '💵 Total des mises', value: `${bet.totalPool}€`, inline: true },
      { name: '👥 Parieurs', value: `${bettorsCount}`, inline: true }
    );
    lockedEmbed.setFields(fields);
    
    const adminRow = msg.components[msg.components.length - 1];
    await msg.edit({ embeds: [lockedEmbed], components: [adminRow] });
    await msg.reply('🔒 **Les paris sont maintenant clôturés !** Le match est en cours. En attente de validation du résultat...');
  } catch (error) {
    console.error('Erreur clôture auto:', error);
  }
}

async function sendReminder(messageId) {
  try {
    const bet = await Bet.findOne({ messageId });
    if (!bet || bet.status !== 'open' || bet.reminderSent) return;
    
    bet.reminderSent = true;
    await bet.save();
    
    const channel = await client.channels.fetch(bet.channelId);
    const msg = await channel.messages.fetch(messageId);
    
    if (bet.isBoosted) {
      await msg.reply('⏰🔥 **DERNIÈRE HEURE POUR LE BOOST !** Ne ratez pas cette cote exceptionnelle !');
    } else {
      await msg.reply('⏰ **Rappel** : Plus qu\'**1 heure** avant la clôture des paris ! Placez vos mises maintenant !');
    }
  } catch (error) {
    console.error('Erreur rappel:', error);
  }
}

// ==================== VÉRIFICATION DES COMBINÉS ====================

async function checkCombisForBet(messageId, winningOptions) {
  try {
    // Trouver tous les combinés confirmés qui contiennent ce pari
    const combis = await Combi.find({ 
      status: 'confirmed',
      'bets.messageId': messageId
    });

    for (const combi of combis) {
      // Incrémenter le compteur de paris résolus
      combi.resolvedBets++;

      // Vérifier si ce pari était gagnant dans le combiné
      const betInCombi = combi.bets.find(b => b.messageId === messageId);
      const isWinningBet = winningOptions.includes(betInCombi.optionIndex);

      if (!isWinningBet) {
        // 🔴 UN PARI PERDU = COMBINÉ PERDU
        combi.status = 'lost';
        await combi.save();

        const user = await getUser(combi.userId);
        user.stats.totalBets++;
        user.stats.lostBets++;
        await user.save();

        // Notification
        const channel = await client.channels.fetch(combi.bets[0].messageId).then(msg => msg.channel).catch(() => null);
        if (channel) {
          await channel.send(`❌ <@${combi.userId}> a perdu son combiné de **${combi.totalStake}€** (cote ${combi.totalOdds.toFixed(2)}x) à cause de : **${betInCombi.question}** ❌`);
        }

        continue;
      }

      // ✅ Ce pari était gagnant, vérifier si tout est résolu
      if (combi.resolvedBets === combi.bets.length) {
        // 🎉 TOUS LES PARIS GAGNÉS !
        combi.status = 'won';
        await combi.save();

        const user = await getUser(combi.userId);
        user.balance += combi.potentialWin;
        user.stats.totalBets++;
        user.stats.wonBets++;
        await user.save();

        // 🎊 ANNONCE PUBLIQUE
        const bet = await Bet.findOne({ messageId: combi.bets[0].messageId });
        const channel = await client.channels.fetch(bet.channelId);

        const winEmbed = new EmbedBuilder()
          .setColor('#FFD700')
          .setTitle('🎰🎉 COMBINÉ GAGNANT ! 🎉🎰')
          .setDescription(`**<@${combi.userId}>** a remporté un combiné de **${combi.bets.length} matchs** !`)
          .addFields(
            { name: '💰 Mise totale', value: `${combi.totalStake}€`, inline: true },
            { name: '📊 Cote totale', value: `${combi.totalOdds.toFixed(2)}x`, inline: true },
            { name: '🏆 GAIN', value: `**${combi.potentialWin}€**`, inline: true },
            { name: '💸 Profit', value: `+${combi.potentialWin - combi.totalStake}€`, inline: true }
          )
          .setFooter({ text: `Bravo ${combi.username} ! 🎊` })
          .setTimestamp();

        let detailsText = '\n**Détails du combiné :**\n';
        combi.bets.forEach(b => {
          detailsText += `✅ ${b.question} → ${b.optionName} (${b.odds}x)\n`;
        });
        winEmbed.setDescription(winEmbed.data.description + detailsText);

        await channel.send({ embeds: [winEmbed] });

        console.log(`🎰 Combiné gagnant pour ${combi.username} : ${combi.potentialWin}€`);
      } else {
        // Encore des matchs en attente
        await combi.save();
      }
    }
  } catch (error) {
    console.error('❌ Erreur vérification combinés:', error);
  }
}

// ==================== ÉVÉNEMENTS ====================

client.once('ready', async () => {
  console.log(`✅ Bot connecté en tant que ${client.user.tag}`);
  
  const activeBets = await Bet.find({ status: 'open', closingTime: { $exists: true, $ne: null } });
  
  for (const bet of activeBets) {
    const timeUntilClosing = new Date(bet.closingTime).getTime() - Date.now();
    
    if (timeUntilClosing > 0) {
      setTimeout(async () => {
        await closeBetAutomatically(bet.messageId);
      }, timeUntilClosing);
      
      const oneHourBefore = timeUntilClosing - (60 * 60 * 1000);
      if (oneHourBefore > 0) {
        setTimeout(async () => {
          await sendReminder(bet.messageId);
        }, oneHourBefore);
      }
    } else if (bet.status === 'open') {
      await closeBetAutomatically(bet.messageId);
    }
  }
});

client.on('interactionCreate', async (interaction) => {
  if (interaction.isButton()) {
    const [action, betId, ...params] = interaction.customId.split('_');
    
    if (action === 'bet') {
      const optionIndex = parseInt(params[0]);
      const bet = await Bet.findOne({ messageId: betId });

      if (!bet) {
        return interaction.reply({ content: '❌ Ce pari n\'existe plus.', ephemeral: true });
      }

      if (!bet.bettors) {
        bet.bettors = {};
      }

      if (bet.bettors[interaction.user.id]) {
        return interaction.reply({ content: '❌ Vous avez déjà parié sur ce match ! Vous ne pouvez parier qu\'une seule fois.', ephemeral: true });
      }

      if (bet.status === 'locked') {
        return interaction.reply({ content: '❌ Les paris sont clôturés. Le match est en cours !', ephemeral: true });
      }

      if (bet.status !== 'open') {
        return interaction.reply({ content: '❌ Ce pari est fermé.', ephemeral: true });
      }

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

      return interaction.showModal(modal);
    }
    
    if (action === 'cancel') {
      const bet = await Bet.findOne({ messageId: betId });

      if (!bet) {
        return interaction.reply({ content: '❌ Ce pari n\'existe plus.', ephemeral: true });
      }

      const member = await interaction.guild.members.fetch(interaction.user.id);
      const hasRole = member.roles.cache.some(role => role.name === BETTING_CREATOR_ROLE);

      if (!hasRole) {
        return interaction.reply({ content: `❌ Vous devez avoir le rôle **"${BETTING_CREATOR_ROLE}"** pour annuler des paris.`, ephemeral: true });
      }

      if (bet.creator !== interaction.user.id) {
        return interaction.reply({ content: '❌ Seul le créateur du pari peut l\'annuler.', ephemeral: true });
      }

      if (bet.status === 'resolved' || bet.status === 'cancelled') {
        return interaction.reply({ content: '❌ Ce pari a déjà été résolu ou annulé.', ephemeral: true });
      }

      // Rembourser les parieurs
      if (bet.bettors && Object.keys(bet.bettors).length > 0) {
        for (const [userId, betData] of Object.entries(bet.bettors)) {
          const user = await getUser(userId);
          user.balance += betData.amount;
          await user.save();
  }
}


      bet.status = 'cancelled';
      await bet.save();

      const updatedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
        .setColor('#808080')
        .setTitle('📊 Pari Annulé');

      await interaction.message.edit({ embeds: [updatedEmbed], components: [] });
      await interaction.reply('✅ Pari annulé et tous les parieurs ont été remboursés.');
    }

    if (action === 'leaderboard') {
      const sortBy = params[0];
      
      const users = await User.find({});
      const userList = users.map(u => ({
        userId: u.userId,
        balance: u.balance,
        stats: u.stats,
        winrate: u.stats.totalBets === 0 ? 0 : parseFloat(((u.stats.wonBets / u.stats.totalBets) * 100).toFixed(1))
      }));

      let sortedUsers;
      let sortEmoji;
      let sortLabel;
      
      if (sortBy === 'winrate') {
        sortedUsers = userList.filter(u => u.stats.totalBets > 0).sort((a, b) => {
          if (Math.abs(b.winrate - a.winrate) > 0.01) {
            return b.winrate - a.winrate;
          }
          return b.stats.totalBets - a.stats.totalBets;
        });
        sortEmoji = '📊';
        sortLabel = 'Winrate';
      } else {
        sortedUsers = userList.sort((a, b) => b.balance - a.balance);
        sortEmoji = '💰';
        sortLabel = 'Solde';
      }

      const top10 = sortedUsers.slice(0, 10);

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

  if (action === 'combi') {
  const subaction = params[0];
  const userId = params[1];

  // Vérifier que c'est bien l'utilisateur qui a créé le combiné
  if (interaction.user.id !== userId) {
    return interaction.reply({ content: '❌ Ce combiné n\'est pas le vôtre !', ephemeral: true });
  }

  if (subaction === 'cancel') {
    // Annuler le combiné
    tempCombis.delete(userId);
    
    const cancelEmbed = EmbedBuilder.from(interaction.message.embeds[0])
      .setColor('#808080')
      .setTitle('🗑️ Combiné Annulé')
      .setDescription('Vous avez annulé la création du combiné.');

    await interaction.update({ embeds: [cancelEmbed], components: [] });
    return;
  }

  if (subaction === 'confirm') {
    // Récupérer les données temporaires
    const basket = tempCombis.get(userId);

    if (!basket) {
      return interaction.reply({ content: '❌ Combiné expiré. Veuillez recréer votre combiné.', ephemeral: true });
    }

    // Vérifier le solde à nouveau
    const user = await getUser(userId);
    if (user.balance < basket.totalStake) {
      tempCombis.delete(userId);
      return interaction.reply({ 
        content: `❌ Solde insuffisant. Vous avez ${user.balance}€, mais le combiné coûte ${basket.totalStake}€.`, 
        ephemeral: true 
      });
    }

    // Déduire le solde
    user.balance -= basket.totalStake;
    await user.save();

    // Créer le combiné dans la DB
    const combiId = `combi_${userId}_${Date.now()}`;

    const newCombi = new Combi({
      combiId,
      userId: userId,
      username: interaction.user.tag,
      bets: basket.bets,
      totalOdds: basket.totalOdds,
      totalStake: basket.totalStake,
      potentialWin: basket.potentialWin,
      status: 'confirmed',
      resolvedBets: 0
    });
    await newCombi.save();

    // Supprimer le panier temporaire
    tempCombis.delete(userId);

    // Confirmation
    const successEmbed = new EmbedBuilder()
      .setColor('#00FF00')
      .setTitle('✅ Combiné Créé !')
      .setDescription(`Votre combiné de **${basket.bets.length} matchs** a été enregistré avec succès.`)
      .addFields(
        { name: '📊 Cote totale', value: `${basket.totalOdds.toFixed(2)}x`, inline: true },
        { name: '💰 Mise', value: `${basket.totalStake}€`, inline: true },
        { name: '🎁 Gain potentiel', value: `${basket.potentialWin}€`, inline: true },
        { name: '🆔 ID du combiné', value: `\`${combiId}\`` },
        { name: '💳 Nouveau solde', value: `${user.balance}€` }
      )
      .setFooter({ text: 'Bonne chance ! Utilisez !mes-combis pour suivre vos combinés' })
      .setTimestamp();

    await interaction.update({ embeds: [successEmbed], components: [] });

    console.log(`✅ Combiné créé : ${combiId} par ${interaction.user.tag} - ${basket.bets.length} paris`);
  }
}

  if (interaction.isModalSubmit()) {
    const [action, subaction, betId, optionIndex] = interaction.customId.split('_');

    if (action === 'bet' && subaction === 'modal') {
      const amount = parseInt(interaction.fields.getTextInputValue('amount'));
      const bet = await Bet.findOne({ messageId: betId });

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
      
      if (!bet.bettors) {
        bet.bettors = {};
      }
      
      if (bet.bettors[interaction.user.id]) {
        return interaction.reply({ content: '❌ Vous avez déjà parié sur ce match ! Vous ne pouvez parier qu\'une seule fois.', ephemeral: true });
      }

      const user = await getUser(interaction.user.id);
      if (user.balance < amount) {
        return interaction.reply({ content: `❌ Solde insuffisant. Vous avez **${user.balance}€**.`, ephemeral: true });
      }

      const optIndex = parseInt(optionIndex);
      const odds = bet.initialOdds[optIndex];
      const potentialWin = calculatePotentialWin(amount, odds);

      // Déduire du solde de l'utilisateur
      user.balance -= amount;
      await user.save();

      // ⚡ OPÉRATION ATOMIQUE : Mise à jour directe dans MongoDB
      // Cela évite les race conditions en modifiant directement la DB
      const updateResult = await Bet.findOneAndUpdate(
        { 
          messageId: betId,
          [`bettors.${interaction.user.id}`]: { $exists: false } // Vérifier qu'il n'a pas déjà parié
        },
        { 
          $set: { 
            [`bettors.${interaction.user.id}`]: {
              option: optIndex,
              amount: amount,
              username: interaction.user.tag,
              odds: odds
            }
          },
          $inc: { totalPool: amount } // Incrémenter atomiquement
        },
        { 
          new: true, // Retourner le document mis à jour
          runValidators: true 
        }
      );

      // Vérifier que la mise à jour a réussi
      if (!updateResult) {
        // L'utilisateur a déjà parié (détecté par la condition $exists: false)
        user.balance += amount; // Rembourser
        await user.save();
        return interaction.reply({ 
          content: '❌ Erreur : vous avez déjà parié ou le pari n\'existe plus.', 
          ephemeral: true 
        });
      }

      console.log(`✅ Pari enregistré pour ${interaction.user.tag} - Total parieurs: ${Object.keys(updateResult.bettors).length}`);

      try {
        const channel = await client.channels.fetch(bet.channelId);
        const betMessage = await channel.messages.fetch(betId);
        
        const updatedBet = await Bet.findOne({ messageId: betId });
        const bettorsCount = Object.keys(updatedBet.bettors).length;
        
        const fields = betMessage.embeds[0].fields.filter(f => !['💰 Comment parier ?', '📈 Statut', '💵 Total des mises', '👥 Parieurs'].includes(f.name));
        fields.push(
          { name: '💰 Comment parier ?', value: 'Cliquez sur le bouton de votre choix ci-dessous' },
          { name: '📈 Statut', value: bet.status === 'open' ? '🟢 En cours' : '🔒 Clôturé', inline: true },
          { name: '💵 Total des mises', value: `${bet.totalPool}€`, inline: true },
          { name: '👥 Parieurs', value: `${bettorsCount}`, inline: true }
        );
        
        const updatedEmbed = EmbedBuilder.from(betMessage.embeds[0]).setFields(fields);
        await betMessage.edit({ embeds: [updatedEmbed] });
        
        await betMessage.reply(`💰 **<@${interaction.user.id}>** a parié **${amount}€** sur **${bet.options[optIndex].name}** (cote ${odds}x) — Gain potentiel : **${potentialWin}€**`);
      } catch (error) {
        console.error('Erreur mise à jour:', error);
      }

      const successEmbed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('✅ Pari Placé !')
        .setDescription(`Vous avez misé **${amount}€** sur **${bet.options[optIndex].name}**`)
        .addFields(
          { name: 'Cote', value: `${odds}x`, inline: true },
          { name: 'Gain potentiel', value: `${potentialWin}€`, inline: true },
          { name: 'Profit potentiel', value: `+${potentialWin - amount}€`, inline: true },
          { name: 'Nouveau solde', value: `${user.balance}€` }
        );

      await interaction.reply({ embeds: [successEmbed], ephemeral: true });
    }
  }
});

// ==================== COMMANDES ====================

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const args = message.content.split(' ');
  const command = args[0].toLowerCase();

  if (command === '!solde' || command === '!balance') {
    const user = await getUser(message.author.id);
    const winrate = await calculateWinrate(message.author.id);
    
    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('💰 Votre Profil')
      .addFields(
        { name: '💵 Solde', value: `**${user.balance}€**`, inline: true },
        { name: '📊 Winrate', value: `**${winrate}%**`, inline: true },
        { name: '🎲 Paris totaux', value: `${user.stats.totalBets}`, inline: true },
        { name: '✅ Gagnés', value: `${user.stats.wonBets}`, inline: true },
        { name: '❌ Perdus', value: `${user.stats.lostBets}`, inline: true }
      )
      .setFooter({ text: message.author.tag })
      .setTimestamp();
    
    message.reply({ embeds: [embed] });
  }

  if (command === '!classement' || command === '!leaderboard' || command === '!top') {
    const sortBy = args[1] || 'solde';
    
    const users = await User.find({});
    const userList = users.map(u => ({
      userId: u.userId,
      balance: u.balance,
      stats: u.stats,
      winrate: u.stats.totalBets === 0 ? 0 : parseFloat(((u.stats.wonBets / u.stats.totalBets) * 100).toFixed(1))
    }));

    let sortedUsers;
    let sortEmoji;
    let sortLabel;
    
    if (sortBy === 'winrate') {
      sortedUsers = userList.filter(u => u.stats.totalBets > 0).sort((a, b) => {
        if (Math.abs(b.winrate - a.winrate) > 0.01) {
          return b.winrate - a.winrate;
        }
        return b.stats.totalBets - a.stats.totalBets;
      });
      sortEmoji = '📊';
      sortLabel = 'Winrate';
    } else {
      sortedUsers = userList.sort((a, b) => b.balance - a.balance);
      sortEmoji = '💰';
      sortLabel = 'Solde';
    }

    const top10 = sortedUsers.slice(0, 10);

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

  if (command === '!profil' || command === '!profile' || command === '!stats') {
    const targetUser = message.mentions.users.first() || message.author;
    const user = await getUser(targetUser.id);
    const winrate = await calculateWinrate(targetUser.id);
    
    const recentHistory = user.history.slice(-5).reverse();

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle(`📊 Profil de ${targetUser.username}`)
      .setThumbnail(targetUser.displayAvatarURL())
      .addFields(
        { name: '💵 Solde', value: `**${user.balance}€**`, inline: true },
        { name: '📊 Winrate', value: `**${winrate}%**`, inline: true },
        { name: '🎲 Paris totaux', value: `${user.stats.totalBets}`, inline: true },
        { name: '✅ Gagnés', value: `${user.stats.wonBets}`, inline: true },
        { name: '❌ Perdus', value: `${user.stats.lostBets}`, inline: true },
        { name: '⚖️ Ratio', value: `${user.stats.wonBets}/${user.stats.lostBets}`, inline: true }
      )
      .setTimestamp();

    if (recentHistory.length > 0) {
      let historyText = '';
      for (const h of recentHistory) {
        const resultEmoji = h.result === 'won' ? '✅' : '❌';
        const profit = h.result === 'won' ? `+${h.winnings - h.amount}€` : `-${h.amount}€`;
        historyText += `${resultEmoji} **${h.question}** — ${h.option} (${h.amount}€) ${profit}\n`;
      }
      embed.addFields({ name: '📜 Historique Récent', value: historyText, inline: false });
    }

    message.reply({ embeds: [embed] });
  }

  if (command === '!paris') {
    const activeBets = await Bet.find({ status: { $in: ['open', 'locked'] } });

    if (activeBets.length === 0) {
      return message.reply('🔭 Aucun pari en cours pour le moment.');
    }

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('📊 Paris En Cours')
      .setDescription(`Il y a actuellement **${activeBets.length}** pari(s) actif(s) :\n\n`)
      .setTimestamp();

    for (const bet of activeBets) {
      const statusEmoji = bet.status === 'locked' ? '🔒' : '🟢';
      const statusText = bet.status === 'locked' ? 'Clôturé' : 'Ouvert';
      const bettorsCount = bet.bettors ? Object.keys(bet.bettors).length : 0;
      
      const optionsList = bet.options.map((opt, i) => `${i + 1}. ${opt.name} (${bet.initialOdds[i]}x)`).join(', ');
      
      let fieldValue = `**ID:** \`${bet.messageId}\`\n**Statut:** ${statusEmoji} ${statusText}\n**Options:** ${optionsList}\n**Parieurs:** ${bettorsCount}\n**Cagnotte:** ${bet.totalPool}€`;
      
      if (bet.closingTime) {
        fieldValue += `\n**Clôture:** <t:${Math.floor(new Date(bet.closingTime).getTime() / 1000)}:R>`;
      }
      
      fieldValue += `\n\n💡 _Pour valider : \`!valider ${bet.messageId} [numéros]\`_`;
      
      embed.addFields({
        name: bet.question,
        value: fieldValue,
        inline: false
      });
    }

    message.reply({ embeds: [embed] });
  }

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

    const donor = await getUser(message.author.id);
    if (donor.balance < amount) {
      return message.reply(`❌ Solde insuffisant. Vous avez **${donor.balance}€**.`);
    }

    const recipient = await getUser(targetUser.id);
    donor.balance -= amount;
    recipient.balance += amount;
    await donor.save();
    await recipient.save();

    const embed = new EmbedBuilder()
      .setColor('#00FF00')
      .setTitle('🎁 Don Effectué')
      .setDescription(`<@${message.author.id}> a fait un don de **${amount}€** à <@${targetUser.id}> !`)
      .addFields(
        { name: 'Donateur', value: `<@${message.author.id}>\nNouveau solde : ${donor.balance}€`, inline: true },
        { name: 'Bénéficiaire', value: `<@${targetUser.id}>\nNouveau solde : ${recipient.balance}€`, inline: true }
      )
      .setTimestamp();

    message.reply({ embeds: [embed] });
  }

  if (command === '!modifier-solde' || command === '!setbalance') {
    const member = await message.guild.members.fetch(message.author.id);
    const hasRole = member.roles.cache.some(role => role.name === BETTING_CREATOR_ROLE);

    if (!hasRole) {
      return message.reply(`❌ Vous devez avoir le rôle **"${BETTING_CREATOR_ROLE}"** pour modifier les soldes.`);
    }

    const targetUser = message.mentions.users.first();
    const amount = parseInt(args[2]);

    if (!targetUser) {
      return message.reply('❌ Vous devez mentionner un utilisateur.\nFormat: `!modifier-solde @user montant`\nExemple: `!modifier-solde @Jean 500`');
    }

    if (isNaN(amount)) {
      return message.reply('❌ Le montant doit être un nombre valide.');
    }

    const user = await getUser(targetUser.id);
    const oldBalance = user.balance;
    user.balance = amount;
    await user.save();

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

if (command === '!annuler-tout' || command === '!cancelall') {
    const member = await message.guild.members.fetch(message.author.id);
    const hasRole = member.roles.cache.some(role => role.name === BETTING_CREATOR_ROLE);

    if (!hasRole) {
      return message.reply(`❌ Vous devez avoir le rôle **"${BETTING_CREATOR_ROLE}"** pour annuler tous les paris.`);
    }

    const activeBets = await Bet.find({ status: { $in: ['open', 'locked'] } });

    if (activeBets.length === 0) {
      return message.reply('❌ Aucun pari actif à annuler.');
    }

    let cancelledCount = 0;
    let refundedAmount = 0;

    for (const bet of activeBets) {
      if (bet.bettors && Object.keys(bet.bettors).length > 0) {
        for (const [userId, betData] of Object.entries(bet.bettors)) {
          const user = await getUser(userId);
          user.balance += betData.amount;
          refundedAmount += betData.amount;
          await user.save();
        }
      }

      bet.status = 'cancelled';
      await bet.save();

      try {
        const channel = await client.channels.fetch(bet.channelId);
        const msg = await channel.messages.fetch(bet.messageId);
        
        const updatedEmbed = EmbedBuilder.from(msg.embeds[0])
          .setColor('#808080')
          .setTitle('📊 Pari Annulé');

        await msg.edit({ embeds: [updatedEmbed], components: [] });
      } catch (error) {
        console.error('Erreur mise à jour message:', error);
      }

      cancelledCount++;
    }

    const embed = new EmbedBuilder()
      .setColor('#FF0000')
      .setTitle('🚫 Tous les Paris Annulés')
      .setDescription(`Tous les paris actifs ont été annulés et les parieurs remboursés.`)
      .addFields(
        { name: 'Paris annulés', value: `${cancelledCount}`, inline: true },
        { name: 'Montant total remboursé', value: `${refundedAmount}€`, inline: true }
      )
      .setFooter({ text: `Par ${message.author.tag}` })
      .setTimestamp();

    message.reply({ embeds: [embed] });
  }

  if (command === '!valider' || command === '!resolve') {
    const betMessageId = args[1];
    const winningOptionsStr = args.slice(2).join(' ');

    if (!betMessageId || !winningOptionsStr) {
      return message.reply('❌ Format incorrect. Utilisez : `!valider [messageId] [numéros des options]`\nEx: `!valider 123456789 1 3` pour valider les options 1 et 3');
    }

    const bet = await Bet.findOne({ messageId: betMessageId });

    if (!bet) {
      return message.reply('❌ Pari introuvable. Vérifiez l\'ID du message.');
    }

    const member = await message.guild.members.fetch(message.author.id);
    const hasRole = member.roles.cache.some(role => role.name === BETTING_CREATOR_ROLE);

    if (!hasRole) {
      return message.reply(`❌ Vous devez avoir le rôle **"${BETTING_CREATOR_ROLE}"** pour valider des paris.`);
    }

    if (bet.creator !== message.author.id) {
      return message.reply('❌ Seul le créateur du pari peut le valider.');
    }

    // CORRECTION: Autoriser la validation des paris 'locked'
    if (bet.status === 'resolved' || bet.status === 'cancelled') {
      return message.reply('❌ Ce pari a déjà été résolu ou annulé.');
    }

    const winningOptions = winningOptionsStr.split(/[\s,]+/).map(n => parseInt(n) - 1);
    
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

  if (command === '!creer-pari' || command === '!createbet') {
    const member = await message.guild.members.fetch(message.author.id);
    const hasRole = member.roles.cache.some(role => role.name === BETTING_CREATOR_ROLE);

    if (!hasRole) {
      return message.reply(`❌ Vous devez avoir le rôle **"${BETTING_CREATOR_ROLE}"** pour créer des paris.`);
    }

    const content = message.content.slice(command.length).trim();
    
    if (!content.includes('|')) {
      return message.reply('❌ Format incorrect. Utilisez : `!creer-pari Question ? | Option 1:cote1 | Option 2:cote2 | heure`\n\nExemple: `!creer-pari Qui gagne ? | PSG:1.5 | OM:3 | 21h30`\nHeure optionnelle (format 24h)');
    }

    const parts = content.split('|').map(p => p.trim());
    const question = parts[0];
    
    let closingTimeStr = null;
    let optionsRaw = parts.slice(1);
    
    const lastPart = parts[parts.length - 1];
    if (/^\d{1,2}h\d{0,2}$/i.test(lastPart.trim())) {
      closingTimeStr = lastPart;
      optionsRaw = parts.slice(1, -1);
    }

    if (optionsRaw.length < 2 || optionsRaw.length > 10) {
      return message.reply('❌ Vous devez avoir entre 2 et 10 options.');
    }

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

    // CORRECTION: Fuseau horaire français
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
          const parisTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
          
          const closingDate = new Date(parisTime);
          closingDate.setHours(targetHour, targetMinute, 0, 0);
          
          if (closingDate.getTime() <= parisTime.getTime()) {
            closingDate.setDate(closingDate.getDate() + 1);
          }
          
          closingTimestamp = closingDate.getTime();
          closingTime = closingDate;
        } else {
          return message.reply('❌ Heure invalide. Format: `21h30` (heure entre 0 et 23, minutes entre 0 et 59)');
        }
      }
    }

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

    if (closingTime) {
      const parisTimeStr = closingTime.toLocaleString('fr-FR', { 
        timeZone: 'Europe/Paris',
        hour: '2-digit', 
        minute: '2-digit',
        hour12: false
      });
      embed.addFields({
        name: '⏰ Clôture des paris',
        value: `${parisTimeStr} (<t:${Math.floor(closingTimestamp / 1000)}:R>)`,
        inline: false
      });
    }

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

    await betMessage.edit({ embeds: [embed], components: finalRows });

    const newBet = new Bet({
      messageId: betMessage.id,
      question,
      options,
      initialOdds: odds,
      bettors: {},
      creator: message.author.id,
      channelId: message.channel.id,
      totalPool: 0,
      status: 'open',
      createdAt: new Date(),
      closingTime: closingTime,
      reminderSent: false
    });
    await newBet.save();

    let replyText = `✅ Pari créé avec succès !\n🆔 ID du message : \`${betMessage.id}\`\n\n_Utilisez cet ID pour valider le pari avec_ \`!valider ${betMessage.id} [options]\``;
    
    if (closingTime) {
      const parisTimeStr = closingTime.toLocaleString('fr-FR', { 
        timeZone: 'Europe/Paris',
        hour: '2-digit', 
        minute: '2-digit',
        hour12: false
      });
      replyText += `\n\n⏰ Les paris seront automatiquement clôturés à **${parisTimeStr}** (<t:${Math.floor(closingTimestamp / 1000)}:R>)`;
      
      const timeUntilClosing = closingTimestamp - Date.now();
      if (timeUntilClosing > 0) {
        setTimeout(async () => {
          await closeBetAutomatically(betMessage.id);
        }, timeUntilClosing);
        
        const oneHourBefore = timeUntilClosing - (60 * 60 * 1000);
        if (oneHourBefore > 0) {
          setTimeout(async () => {
            await sendReminder(betMessage.id);
          }, oneHourBefore);
        }
      }
    }
    
    message.reply(replyText);
  }

  if (command === '!boost') {
    const member = await message.guild.members.fetch(message.author.id);
    const hasRole = member.roles.cache.some(role => role.name === BETTING_CREATOR_ROLE);

    if (!hasRole) {
      return message.reply(`❌ Vous devez avoir le rôle **"${BETTING_CREATOR_ROLE}"** pour créer des paris boostés.`);
    }

    const content = message.content.slice(command.length).trim();
    
    if (!content.includes('|')) {
      return message.reply('❌ Format incorrect. Utilisez : `!boost Nom de l\'event | cote | heure`\n\nExemple: `!boost Victoire PSG | 5.5 | 21h30`');
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
          const parisTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
          
          const closingDate = new Date(parisTime);
          closingDate.setHours(targetHour, targetMinute, 0, 0);
          
          if (closingDate.getTime() <= parisTime.getTime()) {
            closingDate.setDate(closingDate.getDate() + 1);
          }
          
          closingTimestamp = closingDate.getTime();
          closingTime = closingDate;
        }
      }
    }

    const embed = new EmbedBuilder()
      .setColor('#FF00FF')
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
      .setTimestamp();

    if (closingTime) {
      const parisTimeStr = closingTime.toLocaleString('fr-FR', { 
        timeZone: 'Europe/Paris',
        hour: '2-digit', 
        minute: '2-digit',
        hour12: false
      });
      embed.addFields({
        name: '⏰ Clôture',
        value: `${parisTimeStr} (<t:${Math.floor(closingTimestamp / 1000)}:R>)`,
        inline: false
      });
    }

    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`bet_PLACEHOLDER_0`)
          .setLabel(`🔥 PARIER SUR ${eventName.toUpperCase()} (${oddsValue}x) 🔥`)
          .setStyle(ButtonStyle.Danger)
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

    const newBet = new Bet({
      messageId: betMessage.id,
      question: `⚡ BOOST: ${eventName}`,
      options: [{ name: eventName, odds: oddsValue }],
      initialOdds: [oddsValue],
      bettors: {},
      creator: message.author.id,
      channelId: message.channel.id,
      totalPool: 0,
      status: 'open',
      createdAt: new Date(),
      closingTime: closingTime,
      reminderSent: false,
      isBoosted: true
    });
    await newBet.save();

    let replyText = `⚡💎 **PARI BOOSTÉ CRÉÉ !** 💎⚡\n🆔 ID : \`${betMessage.id}\`\n\n_Validez avec_ \`!valider ${betMessage.id} 1\` _(si gagné)_`;
    
    if (closingTime) {
      const parisTimeStr = closingTime.toLocaleString('fr-FR', { 
        timeZone: 'Europe/Paris',
        hour: '2-digit', 
        minute: '2-digit',
        hour12: false
      });
      replyText += `\n\n⏰ Clôture automatique à **${parisTimeStr}**`;
      
      const timeUntilClosing = closingTimestamp - Date.now();
      if (timeUntilClosing > 0) {
        setTimeout(async () => {
          await closeBetAutomatically(betMessage.id);
        }, timeUntilClosing);
        
        const oneHourBefore = timeUntilClosing - (60 * 60 * 1000);
        if (oneHourBefore > 0) {
          setTimeout(async () => {
            await sendReminder(betMessage.id);
          }, oneHourBefore);
        }
      }
    }
    
    message.reply(replyText);
  }

  if (command === '!lock' || command === '!verrouiller') {
  const betMessageId = args[1];

  if (!betMessageId) {
    return message.reply('❌ Format incorrect. Utilisez : `!lock [messageId]`\nExemple: `!lock 123456789`');
  }

  const bet = await Bet.findOne({ messageId: betMessageId });

  if (!bet) {
    return message.reply('❌ Pari introuvable. Vérifiez l\'ID du message.');
  }

  const member = await message.guild.members.fetch(message.author.id);
  const hasRole = member.roles.cache.some(role => role.name === BETTING_CREATOR_ROLE);

  if (!hasRole) {
    return message.reply(`❌ Vous devez avoir le rôle **"${BETTING_CREATOR_ROLE}"** pour verrouiller des paris.`);
  }

  if (bet.creator !== message.author.id) {
    return message.reply('❌ Seul le créateur du pari peut le verrouiller.');
  }

  if (bet.status === 'locked') {
    return message.reply('⚠️ Ce pari est déjà verrouillé.');
  }

  if (bet.status !== 'open') {
    return message.reply('❌ Ce pari ne peut pas être verrouillé (déjà résolu ou annulé).');
  }

  bet.status = 'locked';
  await bet.save();

  try {
    const channel = await client.channels.fetch(bet.channelId);
    const msg = await channel.messages.fetch(betMessageId);
    
    const lockedEmbed = EmbedBuilder.from(msg.embeds[0]).setColor('#FFA500');
    const fields = msg.embeds[0].fields.filter(f => !['📈 Statut', '💵 Total des mises', '👥 Parieurs'].includes(f.name));
    const bettorsCount = bet.bettors ? Object.keys(bet.bettors).length : 0;
    
    fields.push(
      { name: '📈 Statut', value: '🔒 Clôturé (en attente de validation)', inline: true },
      { name: '💵 Total des mises', value: `${bet.totalPool}€`, inline: true },
      { name: '👥 Parieurs', value: `${bettorsCount}`, inline: true }
    );
    lockedEmbed.setFields(fields);
    
    const adminRow = msg.components[msg.components.length - 1];
    await msg.edit({ embeds: [lockedEmbed], components: [adminRow] });
    
    await msg.reply('🔒 **Les paris sont maintenant clôturés manuellement !** En attente de validation du résultat...');
  } catch (error) {
    console.error('Erreur verrouillage:', error);
  }

  const embed = new EmbedBuilder()
    .setColor('#FFA500')
    .setTitle('🔒 Pari Verrouillé')
    .setDescription(`Le pari \`${betMessageId}\` a été verrouillé avec succès.`)
    .addFields(
      { name: '📊 Question', value: bet.question },
      { name: '👥 Parieurs', value: `${bet.bettors ? Object.keys(bet.bettors).length : 0}`, inline: true },
      { name: '💵 Cagnotte', value: `${bet.totalPool}€`, inline: true }
    )
    .setFooter({ text: `Verrouillé par ${message.author.tag}` })
    .setTimestamp();

  message.reply({ embeds: [embed] });
}
    if (command === '!boostloose' || command === '!boostperdu') {
    const betMessageId = args[1];

    if (!betMessageId) {
      return message.reply('❌ Format incorrect. Utilisez : `!boostperdu [messageId]`\nExemple: `!boostperdu 123456789`');
    }

    const bet = await Bet.findOne({ messageId: betMessageId });

    if (!bet) {
      return message.reply('❌ Pari introuvable. Vérifiez l\'ID du message.');
    }

    const member = await message.guild.members.fetch(message.author.id);
    const hasRole = member.roles.cache.some(role => role.name === BETTING_CREATOR_ROLE);

    if (!hasRole) {
      return message.reply(`❌ Vous devez avoir le rôle **"${BETTING_CREATOR_ROLE}"** pour valider des paris.`);
    }

    if (bet.creator !== message.author.id) {
      return message.reply('❌ Seul le créateur du pari peut le valider.');
    }

    if (!bet.isBoosted) {
      return message.reply('❌ Cette commande est réservée aux paris boostés. Utilisez `!valider` pour les paris normaux.');
    }

    if (bet.status === 'resolved' || bet.status === 'cancelled') {
      return message.reply('❌ Ce pari a déjà été résolu ou annulé.');
    }

    // Convertir bettors
    const bettorsObj = bet.bettors instanceof Map 
      ? Object.fromEntries(bet.bettors) 
      : (bet.bettors || {});

    if (Object.keys(bettorsObj).length === 0) {
      return message.reply('⚠️ Aucun parieur sur ce boost.');
    }

    // ❌ BOOST PERDU : Mettre à jour les stats de tous les parieurs
    let lostCount = 0;
    let totalLost = 0;

    for (const [userId, betData] of Object.entries(bettorsObj)) {
      const user = await getUser(userId);
      user.stats.totalBets++;
      user.stats.lostBets++;
      user.history.push({
        betId: bet.messageId,
        question: bet.question,
        option: bet.options[0].name,
        amount: betData.amount,
        winnings: 0,
        result: 'lost',
        timestamp: new Date()
      });
      await user.save();
      lostCount++;
      totalLost += betData.amount;
    }

    // Marquer le boost comme résolu (perdu)
    bet.status = 'resolved';
    bet.winningOptions = []; // Aucun gagnant
    await bet.save();

    // Mettre à jour le message Discord
    try {
      const channel = await client.channels.fetch(bet.channelId);
      const betMessage = await channel.messages.fetch(betMessageId);
      
      const updatedEmbed = EmbedBuilder.from(betMessage.embeds[0])
        .setColor('#000000')
        .setTitle('⚡💎 BOOST PERDU 💎⚡')
        .setDescription(
          `╔════════════════════════════════╗\n` +
          `║                                                              ║\n` +
          `║    ❌ **${bet.options[0].name}** ❌    ║\n` +
          `║                                                              ║\n` +
          `║         **BOOST PERDU**         ║\n` +
          `║                                                              ║\n` +
          `╚════════════════════════════════╝\n\n` +
          `💸 **Tous les parieurs ont perdu leur mise.**`
        );

      await betMessage.edit({ embeds: [updatedEmbed], components: [] });
    } catch (error) {
      console.error('Erreur mise à jour message:', error);
    }

    // Réponse de confirmation
    const resultEmbed = new EmbedBuilder()
      .setColor('#000000')
      .setTitle('❌ Boost Déclaré Perdu')
      .setDescription(`Le boost **${bet.options[0].name}** a été déclaré perdu.`)
      .addFields(
        { name: '👥 Parieurs', value: `${lostCount}`, inline: true },
        { name: '💸 Total perdu', value: `${totalLost}€`, inline: true }
      )
      .setFooter({ text: 'Toutes les mises sont perdues' })
      .setTimestamp();

    message.reply({ embeds: [resultEmbed] });
  }

  if (command === '!combi-add' || command === '!ca') {
  // Format : !combi-add <id1> <opt1> <id2> <opt2> ... <montant>
  
  // Vérification du nombre d'arguments (minimum 5 : 2 paris + montant)
  // 2 paris = 4 args (id1, opt1, id2, opt2) + 1 montant = 5 args minimum
  if (args.length < 5) {
    return message.reply(
      '❌ **Format incorrect !**\n\n' +
      '📋 **Usage :** `!combi-add <id1> <option1> <id2> <option2> ... <montant>`\n\n' +
      '**Exemple avec 2 matchs :**\n' +
      '`!combi-add 123456789 1 987654321 2 100`\n' +
      '→ Pari sur match 123456789 option 1 + match 987654321 option 2 pour 100€\n\n' +
      '**Exemple avec 3 matchs :**\n' +
      '`!combi-add 111111 1 222222 3 333333 2 150`\n\n' +
      '⚠️ **Minimum 2 matchs requis**'
    );
  }

  // Le dernier argument est le montant
  const amount = parseInt(args[args.length - 1]);
  
  if (isNaN(amount) || amount <= 0) {
    return message.reply('❌ Le dernier argument doit être le montant (nombre positif).\nExemple : `!combi-add 123456 1 789012 2 100`');
  }

  // Les autres arguments sont des paires (id, option)
  const pairArgs = args.slice(1, -1); // Retire la commande et le montant
  
  // Vérifier que le nombre d'arguments est pair
  if (pairArgs.length % 2 !== 0) {
    return message.reply(
      '❌ **Arguments invalides !**\n\n' +
      'Vous devez fournir des **paires** (ID du pari + numéro d\'option).\n\n' +
      '✅ **Format correct :**\n' +
      '`!combi-add <id1> <option1> <id2> <option2> <montant>`\n\n' +
      `Vous avez fourni ${pairArgs.length} arguments (doit être pair).`
    );
  }

  // Vérifier minimum 2 paris
  const numberOfBets = pairArgs.length / 2;
  if (numberOfBets < 2) {
    return message.reply('❌ Un combiné doit contenir **au minimum 2 paris**.');
  }

  // Vérifier le solde AVANT de traiter
  const user = await getUser(message.author.id);
  if (user.balance < amount) {
    return message.reply(`❌ Solde insuffisant. Vous avez **${user.balance}€**, le combiné coûte **${amount}€**.`);
  }

  // Préparer les données du combiné
  const combiBets = [];
  let totalOdds = 1;
  const seenBets = new Set(); // Pour éviter les doublons

  // Traiter chaque paire (id, option)
  for (let i = 0; i < pairArgs.length; i += 2) {
    const betMessageId = pairArgs[i];
    const optionNum = parseInt(pairArgs[i + 1]);

    // Vérifier que l'option est un nombre
    if (isNaN(optionNum)) {
      return message.reply(`❌ L'argument ${i + 2} (option pour le pari ${i / 2 + 1}) doit être un **numéro** d'option.\nReçu : "${pairArgs[i + 1]}"`);
    }

    // Vérifier les doublons
    if (seenBets.has(betMessageId)) {
      return message.reply(`❌ Vous ne pouvez pas parier **deux fois** sur le même match !\nMatch dupliqué : \`${betMessageId}\``);
    }
    seenBets.add(betMessageId);

    // Récupérer le pari depuis la DB
    const bet = await Bet.findOne({ messageId: betMessageId });
    
    if (!bet) {
      return message.reply(`❌ Pari introuvable : \`${betMessageId}\`\nUtilisez \`!paris\` pour voir les IDs disponibles.`);
    }

    if (bet.status !== 'open') {
      return message.reply(`❌ Le pari \`${betMessageId}\` est **fermé ou clôturé**.\nQuestion : "${bet.question}"`);
    }

    const optionIndex = optionNum - 1;
    if (optionIndex < 0 || optionIndex >= bet.options.length) {
      return message.reply(
        `❌ Option invalide pour le pari "${bet.question}"\n` +
        `Vous avez choisi l'option **${optionNum}**, mais ce pari a **${bet.options.length} option(s)**.\n` +
        `Options disponibles : ${bet.options.map((o, i) => `${i + 1}. ${o.name}`).join(', ')}`
      );
    }

    // Vérifier qu'il n'a pas déjà parié sur ce match (pari simple)
    if (bet.bettors && bet.bettors[message.author.id]) {
      return message.reply(
        `❌ Vous avez déjà un **pari simple** sur ce match !\n` +
        `Match : "${bet.question}"\n` +
        `Impossible de l'ajouter à un combiné.`
      );
    }

    // Ajouter au combiné
    const odds = bet.initialOdds[optionIndex];
    combiBets.push({
      betId: bet._id.toString(),
      messageId: betMessageId,
      question: bet.question,
      optionIndex,
      optionName: bet.options[optionIndex].name,
      odds,
      amount: Math.floor(amount / numberOfBets) // Répartition égale (arrondi à l'entier inférieur)
    });

    totalOdds *= odds;
  }

  // Calcul du gain potentiel
  const potentialWin = Math.floor(amount * totalOdds);
  const profit = potentialWin - amount;

  // Créer l'embed de confirmation
  let betsDescription = '';
  combiBets.forEach((b, i) => {
    betsDescription += `**${i + 1}.** ${b.question}\n`;
    betsDescription += `   ➜ ${b.optionName} **(cote ${b.odds}x)**\n\n`;
  });

  const confirmEmbed = new EmbedBuilder()
    .setColor('#FFA500')
    .setTitle('⚠️ Confirmation de Combiné')
    .setDescription(
      `Vous êtes sur le point de créer un combiné de **${combiBets.length} matchs** :\n\n` +
      betsDescription
    )
    .addFields(
      { name: '📊 Cote totale', value: `**${totalOdds.toFixed(2)}x**`, inline: true },
      { name: '💰 Mise totale', value: `**${amount}€**`, inline: true },
      { name: '🎯 Gain potentiel', value: `**${potentialWin}€**`, inline: true },
      { name: '💸 Profit', value: `**+${profit}€**`, inline: true },
      { name: '💳 Votre solde après', value: `${user.balance - amount}€`, inline: true },
      { name: '\u200b', value: '\u200b', inline: true }
    )
    .setFooter({ text: 'Cliquez sur ✅ pour confirmer ou ❌ pour annuler' })
    .setTimestamp();

  // Créer les boutons de confirmation
  const confirmRow = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(`combi_confirm_${message.author.id}_${Date.now()}`)
        .setLabel('✅ Valider le Combiné')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`combi_cancel_${message.author.id}`)
        .setLabel('❌ Annuler')
        .setStyle(ButtonStyle.Danger)
    );

  // Stocker temporairement les données du combiné
  tempCombis.set(message.author.id, {
    bets: combiBets,
    totalOdds,
    totalStake: amount,
    potentialWin,
    timestamp: Date.now()
  });

  await message.reply({ embeds: [confirmEmbed], components: [confirmRow] });
}

  if (command === '!combi-cancel' || command === '!cc') {
  const combiId = args[1];

  if (!combiId) {
    return message.reply('❌ Format : `!combi-cancel [combiId]`');
  }

  const combi = await Combi.findOne({ combiId, userId: message.author.id });

  if (!combi) {
    return message.reply('❌ Combiné introuvable ou vous n\'en êtes pas le propriétaire.');
  }

  if (combi.status === 'won' || combi.status === 'lost') {
    return message.reply('❌ Ce combiné est déjà résolu.');
  }

  if (combi.status === 'cancelled') {
    return message.reply('❌ Ce combiné est déjà annulé.');
  }

  // Vérifier qu'aucun pari du combiné n'est résolu
  for (const bet of combi.bets) {
    const betData = await Bet.findOne({ messageId: bet.messageId });
    if (betData && betData.status === 'resolved') {
      return message.reply('❌ Impossible d\'annuler : au moins un match est déjà terminé.');
    }
  }

  // Rembourser
  const user = await getUser(message.author.id);
  user.balance += combi.totalStake;
  await user.save();

  combi.status = 'cancelled';
  await combi.save();

  const embed = new EmbedBuilder()
    .setColor('#FFA500')
    .setTitle('🚫 Combiné Annulé')
    .setDescription(`Votre combiné a été annulé et vous avez été remboursé.`)
    .addFields(
      { name: '💰 Montant remboursé', value: `${combi.totalStake}€`, inline: true },
      { name: '💳 Nouveau solde', value: `${user.balance}€`, inline: true }
    );

  message.reply({ embeds: [embed] });
}

  if (command === '!mes-combis' || command === '!mc') {
  const combis = await Combi.find({ userId: message.author.id }).sort({ createdAt: -1 }).limit(10);

  if (combis.length === 0) {
    return message.reply('📭 Vous n\'avez aucun combiné enregistré.');
  }

  const embed = new EmbedBuilder()
    .setColor('#FFD700')
    .setTitle('🎰 Vos Combinés')
    .setDescription(`Vous avez **${combis.length}** combiné(s) récent(s) :`);

  for (const combi of combis) {
    const statusEmoji = {
      'confirmed': '⏳',
      'won': '✅',
      'lost': '❌',
      'cancelled': '🚫'
    }[combi.status];

    const statusText = {
      'confirmed': 'En cours',
      'won': `GAGNÉ - ${combi.potentialWin}€`,
      'lost': 'Perdu',
      'cancelled': 'Annulé'
    }[combi.status];

    let fieldValue = `**Statut :** ${statusEmoji} ${statusText}\n`;
    fieldValue += `**Mise :** ${combi.totalStake}€ | **Cote :** ${combi.totalOdds.toFixed(2)}x\n`;
    fieldValue += `**Matchs :** ${combi.bets.length} | **Résolus :** ${combi.resolvedBets}/${combi.bets.length}\n`;
    fieldValue += `**ID :** \`${combi.combiId}\``;

    embed.addFields({
      name: `📅 ${new Date(combi.createdAt).toLocaleDateString('fr-FR')}`,
      value: fieldValue,
      inline: false
    });
  }

  message.reply({ embeds: [embed] });
}
  
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
        { name: '!annuler-tout', value: '🚫 Annule TOUS les paris actifs et rembourse tout le monde' },
        { name: '⏰ Clôture automatique', value: 'Heure absolue (ex: 21h30 = clôture à 21h30)\nRappel automatique 1h avant\nPari reste ouvert pour validation après clôture' },
        { name: '📊 Cotes', value: 'Gain = Mise × Cote\nExemple: 50€ × 2.5 = 125€ de gain' }
      )
      .setFooter({ text: 'Bot de Paris Discord' });

    message.reply({ embeds: [helpEmbed] });
  }

  if (command === '!debug-pari') {
    const member = await message.guild.members.fetch(message.author.id);
    const hasRole = member.roles.cache.some(role => role.name === BETTING_CREATOR_ROLE);

    if (!hasRole) {
      return message.reply('❌ Rôle requis.');
    }

      const betMessageId = args[1];
    if (!betMessageId) {
      return message.reply('Usage: `!debug-pari [messageId]`');
    }

      const bet = await Bet.findOne({ messageId: betMessageId });
    if (!bet) {
      return message.reply('❌ Pari introuvable.');
    }

      const bettorsArray = Object.entries(bet.bettors);
    
      const embed = new EmbedBuilder()
      .setColor('#FFA500')
      .setTitle('🔍 Debug du Pari')
      .addFields(
        { name: 'ID', value: betMessageId },
        { name: 'Statut', value: bet.status },
        { name: 'Parieurs dans DB', value: `${bettorsArray.length}` },
        { name: 'Total Pool', value: `${bet.totalPool}€` },
        { name: 'Détails', value: bettorsArray.length > 0 ? 
          bettorsArray.map(([id, data]) => `<@${id}>: ${data.amount}€ sur option ${data.option + 1}`).join('\n') 
          : 'Aucun parieur' 
        }
      );

    message.reply({ embeds: [embed] });
  }
});

// Gestion du bouton de validation
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;
  
  const [action, betId, ...params] = interaction.customId.split('_');
  
if (action === 'validate') {
    const winningOptions = params.map(p => parseInt(p));
    const bet = await Bet.findOne({ messageId: betId });

    if (!bet) {
      return interaction.reply({ content: '❌ Ce pari n\'existe plus.', ephemeral: true });
    }

    console.log('🔍 Validation - Type de bettors:', typeof bet.bettors);
    console.log('🔍 Validation - Bettors:', bet.bettors);
    console.log('🔍 Validation - Nombre de clés:', bet.bettors ? Object.keys(bet.bettors).length : 0);

    // Convertir bet.bettors en objet plain si c'est une Map MongoDB
    const bettorsObj = bet.bettors instanceof Map 
      ? Object.fromEntries(bet.bettors) 
      : (bet.bettors || {});

    console.log('🔍 Après conversion - Nombre de parieurs:', Object.keys(bettorsObj).length);

    if (Object.keys(bettorsObj).length === 0) {
      return interaction.reply({ content: '⚠️ Aucun parieur sur ce match.', ephemeral: true });
    }

    const member = await interaction.guild.members.fetch(interaction.user.id);
    const hasRole = member.roles.cache.some(role => role.name === BETTING_CREATOR_ROLE);

    if (!hasRole) {
      return interaction.reply({ content: `❌ Vous devez avoir le rôle **"${BETTING_CREATOR_ROLE}"**.`, ephemeral: true });
    }

    if (bet.creator !== interaction.user.id) {
      return interaction.reply({ content: '❌ Seul le créateur du pari peut le valider.', ephemeral: true });
    }

    if (bet.status === 'resolved' || bet.status === 'cancelled') {
      return interaction.reply({ content: '❌ Ce pari a déjà été résolu ou annulé.', ephemeral: true });
    }

    // Filtrer les gagnants
    const winners = Object.entries(bettorsObj).filter(([userId, betData]) => {
      console.log(`🔍 Vérif ${userId} - option: ${betData.option}, gagnantes: ${winningOptions.join(',')}`);
      return winningOptions.includes(betData.option);
    });

    console.log(`🏆 Nombre de gagnants: ${winners.length}`);

    // CAS 1 : Aucun gagnant
    if (winners.length === 0) {
      await interaction.reply('⚠️ Aucun gagnant pour ce pari. Les mises sont perdues.');
      
      // Mettre à jour les stats de tous les parieurs (tous perdants)
      for (const [userId, betData] of Object.entries(bettorsObj)) {
        const user = await getUser(userId);
        user.stats.totalBets++;
        user.stats.lostBets++;
        user.history.push({
          betId: bet.messageId,
          question: bet.question,
          option: bet.options[betData.option].name,
          amount: betData.amount,
          winnings: 0,
          result: 'lost',
          timestamp: new Date()
        });
        await user.save();
      }
      
      bet.status = 'resolved';
      bet.winningOptions = winningOptions;
      await bet.save();
      
      const updatedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
        .setColor('#FF0000')
        .setTitle('📊 Pari Terminé - Aucun Gagnant');
      
      await interaction.message.edit({ embeds: [updatedEmbed], components: [] });
      await checkCombisForBet(betId, winningOptions);
      return;
    }

    // CAS 2 : Il y a des gagnants
    let distributionText = '🏆 **Résultats du pari**\n\n';
    distributionText += `Options gagnantes : ${winningOptions.map(i => bet.options[i].name).join(', ')}\n\n`;

    let totalDistributed = 0;

    // Traiter tous les parieurs
    for (const [userId, betData] of Object.entries(bettorsObj)) {
      const user = await getUser(userId);
      user.stats.totalBets++;
      
      if (winningOptions.includes(betData.option)) {
        // GAGNANT
        user.stats.wonBets++;
        const odds = bet.initialOdds[betData.option];
        const winnings = calculatePotentialWin(betData.amount, odds);
        const profit = winnings - betData.amount;
        
        user.balance += winnings;
        totalDistributed += winnings;
        
        distributionText += `• <@${userId}> : Misé ${betData.amount}€ (cote ${odds}x) → Gagné **${winnings}€** (profit: +${profit}€)\n`;
        
        user.history.push({
          betId: bet.messageId,
          question: bet.question,
          option: bet.options[betData.option].name,
          amount: betData.amount,
          winnings: winnings,
          result: 'won',
          timestamp: new Date()
        });

        console.log(`✅ ${userId} a gagné ${winnings}€`);
      } else {
        // PERDANT
        user.stats.lostBets++;
        
        user.history.push({
          betId: bet.messageId,
          question: bet.question,
          option: bet.options[betData.option].name,
          amount: betData.amount,
          winnings: 0,
          result: 'lost',
          timestamp: new Date()
        });

        console.log(`❌ ${userId} a perdu ${betData.amount}€`);
      }
      
      await user.save();
    }

    bet.status = 'resolved';
    bet.winningOptions = winningOptions;
    await bet.save();

    const updatedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
      .setColor('#00FF00')
      .setTitle('📊 Pari Terminé')
      .addFields(
        { name: '✅ Résultat', value: winningOptions.map(i => `${bet.options[i].name} (${bet.initialOdds[i]}x)`).join('\n'), inline: true },
        { name: '💵 Total distribué', value: `${totalDistributed}€`, inline: true },
        { name: '👥 Gagnants', value: `${winners.length}`, inline: true }
      );

    await interaction.message.edit({ embeds: [updatedEmbed], components: [] });
    await interaction.reply(distributionText);
    await checkCombisForBet(betId, winningOptions);
  
    console.log(`✅ Validation terminée - ${winners.length} gagnants, ${totalDistributed}€ distribués`);
  }
});

client.on('error', console.error);

client.login(config.token);

setInterval(() => {
  try {
    https.get(process.env.RENDER_EXTERNAL_URL, res => {
      console.log('🔁 Ping Render OK');
    }).on('error', () => {
      console.log('⚠️ Ping Render échoué');
    });
  } catch (err) {
    console.log('⚠️ Erreur ping');
  }
}, 5 * 60 * 1000);
