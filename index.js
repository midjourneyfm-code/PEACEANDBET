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
  milestonesReached: { type: [Number], default: [] },
  // ⭐ NOUVEAU : Système de winstreak
  currentStreak: { type: Number, default: 0 },
  bestStreak: { type: Number, default: 0 },
  streakHistory: [{
    streak: Number,
    endedAt: Date,
    bets: [{
      question: String,
      option: String,
      amount: Number,
      winnings: Number,
      type: String, // 'simple' ou 'combi'
      timestamp: Date
    }]
  }],
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

const dailySpinSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  lastSpin: { type: Date, default: null }
});

const User = mongoose.model('User', userSchema);
const Bet = mongoose.model('Bet', betSchema);
const DailySpin = mongoose.model('DailySpin', dailySpinSchema);

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
  status: { type: String, default: 'pending' },
  createdAt: { type: Date, default: Date.now },
  resolvedBets: { type: Number, default: 0 },
  processedBets: [String] // ⭐ AJOUTEZ CETTE LIGNE
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
const activeSafeOrRiskGames = new Map(); // userId -> { stake, currentMultiplier, round, messageId }

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

function getSafeOrRiskMultipliers() {
  return [
    { round: 1, multiplier: 1.1, winChance: 80 },
    { round: 2, multiplier: 1.1, winChance: 70 },
    { round: 3, multiplier: 1.5, winChance: 60 },
    { round: 4, multiplier: 2.1, winChance: 40 },
    { round: 5, multiplier: 3.5, winChance: 30 },
    { round: 6, multiplier: 4.5, winChance: 25 },
    { round: 7, multiplier: 8.1, winChance: 12 },
    { round: 8, multiplier: 12.0, winChance: 9 },
    { round: 9, multiplier: 18.0, winChance: 7 },
    { round: 10, multiplier: 30.0, winChance: 5 }
  ];
}

function createSafeOrRiskEmbed(game, roundData) {
  const potentialWin = Math.floor(game.stake * roundData.multiplier);
  const profit = potentialWin - game.stake;
  
  let progressBar = '';
  for (let i = 1; i <= 10; i++) {
    if (i < game.round) {
      progressBar += '✅';
    } else if (i === game.round) {
      progressBar += '🎯';
    } else {
      progressBar += '⬜';
    }
  }

  const embed = new EmbedBuilder()
    .setColor('#FF6B00')
    .setTitle('🎲 SAFE OR RISK 🎲')
    .setDescription(
      `**Tour ${game.round}/10**\n\n` +
      `${progressBar}\n\n` +
      `💰 **Mise de départ :** ${game.stake}€\n` +
      `📊 **Multiplicateur actuel :** **x${roundData.multiplier}**\n` +
      `💎 **Gain potentiel :** **${potentialWin}€**\n` +
      `💸 **Profit :** **+${profit}€**\n\n` +
      `🎯 **Chance de réussite :** ${roundData.winChance}%\n` +
      `💥 **Risque d'échec :** ${100 - roundData.winChance}%`
    )
    .setFooter({ text: '⚠️ Plus tu montes, plus le risque augmente !' })
    .setTimestamp();

  return embed;
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

async function handleWinstreak(user, channelId, betDetails) {
  // betDetails = { question, option, amount, winnings, type: 'simple' ou 'combi' }
  
  const oldStreak = user.currentStreak;
  user.currentStreak++;
  
  // Ajouter le pari à l'historique de streak actuelle
  if (!user.streakHistory) user.streakHistory = [];
  
  // Trouver ou créer la streak en cours
  let currentStreakRecord = user.streakHistory.find(s => s.streak === user.currentStreak && !s.endedAt);
  if (!currentStreakRecord) {
    currentStreakRecord = {
      streak: user.currentStreak,
      bets: []
    };
    user.streakHistory.push(currentStreakRecord);
  }
  
  // Ajouter le pari à la streak
  currentStreakRecord.bets.push({
    question: betDetails.question,
    option: betDetails.option,
    amount: betDetails.amount,
    winnings: betDetails.winnings,
    type: betDetails.type,
    timestamp: new Date()
  });
  
  // Mettre à jour le record
  if (user.currentStreak > user.bestStreak) {
    user.bestStreak = user.currentStreak;
  }
  
  let bonusAmount = 0;
  let announcement = '';
  
  // 🔥 BONUS À PARTIR DE 3 VICTOIRES CONSÉCUTIVES
  if (user.currentStreak >= 3) {
    bonusAmount = 5;
    user.balance += bonusAmount;
    
    const streakEmojis = {
      3: '🔥',
      5: '🔥🔥',
      7: '🔥🔥🔥',
      10: '⚡🔥',
      15: '💎🔥',
      20: '👑🔥'
    };
    
    const emoji = streakEmojis[user.currentStreak] || (user.currentStreak >= 20 ? '👑🔥' : '🔥');
    
    try {
      const channel = await client.channels.fetch(channelId);
      
      const streakEmbed = new EmbedBuilder()
        .setColor('#FF6B00')
        .setTitle(`${emoji} WINSTREAK EN COURS ! ${emoji}`)
        .setDescription(
          `**<@${user.userId}>** est en FEU avec **${user.currentStreak} victoires** consécutives !\n\n` +
          `🎁 **BONUS WINSTREAK :** +${bonusAmount}€\n` +
          `💰 **Nouveau solde :** ${user.balance}€`
        )
        .addFields(
          { name: '📈 Streak actuelle', value: `${user.currentStreak} 🔥`, inline: true },
          { name: '🏆 Meilleur record', value: `${user.bestStreak}`, inline: true },
          { name: '💡 Astuce', value: 'Continue de gagner pour augmenter ton bonus !', inline: false }
        )
        .setFooter({ text: `${oldStreak} → ${user.currentStreak} | +${bonusAmount}€ bonus` })
        .setTimestamp();
      
      await channel.send({ embeds: [streakEmbed] });
      
      console.log(`🔥 ${user.userId} winstreak ${user.currentStreak} (+${bonusAmount}€)`);
    } catch (error) {
      console.error('Erreur annonce winstreak:', error);
    }
  } else if (user.currentStreak === 2) {
    // Annonce qu'il est à 1 victoire du bonus
    try {
      const channel = await client.channels.fetch(channelId);
      await channel.send(
        `🔥 **<@${user.userId}>** a **2 victoires** consécutives ! ` +
        `Plus qu'**1 victoire** pour débloquer le **BONUS WINSTREAK** de 5€ par pari ! 🎁`
      );
    } catch (error) {
      console.error('Erreur annonce streak 2:', error);
    }
  }
  
  await user.save();
  return bonusAmount;
}

async function breakWinstreak(user, channelId) {
  if (user.currentStreak === 0) return; // Pas de streak en cours
  
  const lostStreak = user.currentStreak;
  
  // Marquer la fin de la streak dans l'historique
  if (user.streakHistory && user.streakHistory.length > 0) {
    const lastStreak = user.streakHistory[user.streakHistory.length - 1];
    if (!lastStreak.endedAt) {
      lastStreak.endedAt = new Date();
    }
  }
  
  user.currentStreak = 0;
  await user.save();
  
  // Annonce de perte de streak (seulement si >= 3)
  if (lostStreak >= 3) {
    try {
      const channel = await client.channels.fetch(channelId);
      
      const breakEmbed = new EmbedBuilder()
        .setColor('#808080')
        .setTitle('💔 WINSTREAK TERMINÉE')
        .setDescription(
          `**<@${user.userId}>** a perdu sa série de **${lostStreak} victoires** consécutives.\n\n` +
          `La prochaine fois sera la bonne ! 💪`
        )
        .addFields(
          { name: '📉 Streak perdue', value: `${lostStreak} 🔥`, inline: true },
          { name: '🏆 Meilleur record', value: `${user.bestStreak}`, inline: true }
        )
        .setTimestamp();
      
      await channel.send({ embeds: [breakEmbed] });
      
      console.log(`💔 ${user.userId} perd sa winstreak de ${lostStreak}`);
    } catch (error) {
      console.error('Erreur annonce break streak:', error);
    }
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

function createProgressBar(current, total, length = 10) {
  const filled = Math.floor((current / total) * length);
  const empty = length - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

async function canSpinToday(userId) {
  const spinData = await DailySpin.findOne({ userId });
  
  if (!spinData || !spinData.lastSpin) {
    return true; // Jamais tourné
  }
  
  const now = new Date();
  const lastSpin = new Date(spinData.lastSpin);
  
  // Vérifier si c'est un jour différent
  const isSameDay = 
    now.getFullYear() === lastSpin.getFullYear() &&
    now.getMonth() === lastSpin.getMonth() &&
    now.getDate() === lastSpin.getDate();
  
  return !isSameDay;
}

async function updateLastSpin(userId) {
  await DailySpin.findOneAndUpdate(
    { userId },
    { lastSpin: new Date() },
    { upsert: true }
  );
}

function spinRoulette() {
  const random = Math.random() * 100; // 0-100
  
  if (random < 30) return 1;        // 30%
  if (random < 55) return 5;        // 25%
  if (random < 70) return 8;        // 15%
  if (random < 80) return 10;       // 10%
  if (random < 88) return 20;       // 8%
  if (random < 94) return 30;       // 6%
  if (random < 99) return 50;       // 5%
  return 80;                        // 1%
}

function checkMilestone(wonBets) {
  const milestones = [
    // Paliers 5-20 : +5€
    { threshold: 5, reward: 5 },
    { threshold: 10, reward: 5 },
    { threshold: 15, reward: 5 },
    { threshold: 20, reward: 5 },
    // Paliers 30-50 : +8€
    { threshold: 30, reward: 8 },
    { threshold: 40, reward: 8 },
    { threshold: 50, reward: 8 },
    // Paliers 65-95 : +10€
    { threshold: 65, reward: 10 },
    { threshold: 80, reward: 10 },
    { threshold: 95, reward: 10 },
    // Paliers 115-190 : +15€
    { threshold: 115, reward: 15 },
    { threshold: 135, reward: 15 },
    { threshold: 155, reward: 15 },
    { threshold: 175, reward: 15 },
    { threshold: 190, reward: 15 },
    // Paliers 220-400 : +20€
    { threshold: 220, reward: 20 },
    { threshold: 250, reward: 20 },
    { threshold: 280, reward: 20 },
    { threshold: 310, reward: 20 },
    { threshold: 340, reward: 20 },
    { threshold: 370, reward: 20 },
    { threshold: 400, reward: 20 },
    // Paliers spéciaux
    { threshold: 450, reward: 50 },
    { threshold: 500, reward: 100 }
  ];

  return milestones.find(m => m.threshold === wonBets) || null;
}

function getNextMilestone(currentWonBets) {
  const allMilestones = [5, 10, 15, 20, 30, 40, 50, 65, 80, 95, 115, 135, 155, 175, 190, 220, 250, 280, 310, 340, 370, 400, 450, 500];
  return allMilestones.find(m => m > currentWonBets) || '500 (max)';
}

async function handleMilestone(user, channelId) {
  const milestone = checkMilestone(user.stats.wonBets);
  
  if (milestone && !user.milestonesReached.includes(milestone.threshold)) {
    user.balance += milestone.reward;
    user.milestonesReached.push(milestone.threshold);
    
    // Annonce publique
    try {
      const channel = await client.channels.fetch(channelId);
      const milestoneEmbed = new EmbedBuilder()
        .setColor('#FFD700')
        .setTitle('🎊🏆 PALIER ATTEINT ! 🏆🎊')
        .setDescription(
          `🎉 **<@${user.userId}>** vient d'atteindre le palier **${milestone.threshold} paris gagnés** !\n\n` +
          `💰 **Récompense :** +${milestone.reward}€\n` +
          `💳 **Nouveau solde :** ${user.balance}€`
        )
        .setFooter({ text: `🎯 Prochain palier : ${getNextMilestone(user.stats.wonBets)} paris gagnés` })
        .setTimestamp();
      
      await channel.send({ embeds: [milestoneEmbed] });
    } catch (error) {
      console.error('Erreur annonce palier:', error);
    }
  }
}

// ==================== VÉRIFICATION DES COMBINÉS ====================

async function checkCombisForBet(messageId, winningOptions) {
  try {
    // ⭐ MODIFICATION : Ne chercher QUE les combinés "confirmed" (pas les "lost")
    const combis = await Combi.find({ 
      status: 'confirmed', // ✅ Ignore automatiquement les combinés déjà perdus
      'bets.messageId': messageId
    });

    console.log(`🔍 ${combis.length} combiné(s) actif(s) affecté(s) par le pari ${messageId}`);

    const combiNotifications = [];

    for (const combi of combis) {
      console.log(`\n📊 COMBI ${combi.combiId} - État AVANT traitement:`);
      console.log(`   - resolvedBets: ${combi.resolvedBets}/${combi.bets.length}`);
      console.log(`   - status: ${combi.status}`);
      
      // Vérifier si ce pari était gagnant dans le combiné
      const betInCombi = combi.bets.find(b => b.messageId === messageId);
      
      if (!betInCombi) {
        console.log(`⚠️ Pari ${messageId} introuvable dans le combiné ${combi.combiId}`);
        continue;
      }
      
      // ⭐ VÉRIFIER SI CE PARI A DÉJÀ ÉTÉ COMPTÉ
      const alreadyProcessedBets = combi.processedBets || [];
      if (alreadyProcessedBets.includes(messageId)) {
        console.log(`⚠️ Pari ${messageId} déjà traité pour ce combiné, skip`);
        continue;
      }
      
      const isWinningBet = winningOptions.includes(betInCombi.optionIndex);
      console.log(`   - Option pariée: ${betInCombi.optionIndex} (${betInCombi.optionName})`);
      console.log(`   - Options gagnantes: [${winningOptions.join(', ')}]`);
      console.log(`   - Est gagnant? ${isWinningBet ? '✅' : '❌'}`);

if (!isWinningBet) {
  // 🔴 UN PARI PERDU = COMBINÉ PERDU
  console.log(`❌ COMBINÉ PERDU pour ${combi.username}`);
  combi.status = 'lost';
  
  // Marquer ce pari comme traité
  if (!combi.processedBets) combi.processedBets = [];
  combi.processedBets.push(messageId);
  
  await combi.save();

  const user = await getUser(combi.userId);
  user.stats.totalBets++;
  user.stats.lostBets++;
  const betRecord = await Bet.findOne({ messageId: messageId });
if (betRecord) {
  await breakWinstreak(user, betRecord.channelId);
}
  
  // ⭐ AJOUTER L'HISTORIQUE
  user.history.push({
    betId: combi.combiId,
    question: `Combiné ${combi.bets.length} matchs`,
    option: `Cote ${combi.totalOdds.toFixed(2)}x`,
    amount: combi.totalStake,
    winnings: 0,
    result: 'lost',
    timestamp: new Date()
  });
  
  await user.save();

  

{
  // ⭐⭐⭐ ANNONCE PUBLIQUE (AJOUT MANQUANT) ⭐⭐⭐
  try {
    const betRecord = await Bet.findOne({ messageId: messageId });
    if (betRecord) {
      const channel = await client.channels.fetch(betRecord.channelId);
      
      const lostEmbed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('💔 Combiné Perdu')
        .setDescription(`<@${combi.userId}> a perdu son combiné de **${combi.bets.length} matchs**`)
        .addFields(
          { name: '💰 Mise perdue', value: `${combi.totalStake}€`, inline: true },
          { name: '📊 Cote', value: `${combi.totalOdds.toFixed(2)}x`, inline: true },
          { name: '❌ Pari perdant', value: `**${betInCombi.question}**\n→ ${betInCombi.optionName}` }
        )
        .setFooter({ text: `ID: ${combi.combiId}` })
        .setTimestamp();
      
      await channel.send({ embeds: [lostEmbed] });
    }
  } catch (error) {
    console.error('❌ Erreur annonce combiné perdu:', error);
  }
}
  // ⭐⭐⭐ FIN DE L'AJOUT ⭐⭐⭐

  // Notification pour le message de validation (garder l'existant)
  combiNotifications.push({
    userId: combi.userId,
    username: combi.username,
    type: 'lost',
    question: betInCombi.question,
    optionName: betInCombi.optionName,
    stake: combi.totalStake,
    odds: combi.totalOdds,
    combiId: combi.combiId,
    totalBets: combi.bets.length
  });

  continue;
}

      // ✅ Ce pari était gagnant - MAINTENANT on incrémente
      combi.resolvedBets++;
      
      // Marquer ce pari comme traité
      if (!combi.processedBets) combi.processedBets = [];
      combi.processedBets.push(messageId);
      
      console.log(`✅ Pari gagnant ! Nouvelle progression: ${combi.resolvedBets}/${combi.bets.length}`);

      // ⭐ VÉRIFICATION STRICTE : Est-ce vraiment le dernier pari ?
      if (combi.resolvedBets === combi.bets.length) {
        console.log(`🎉 TOUS LES PARIS VALIDÉS ET GAGNANTS !`);
        
        // 🎉 TOUS LES PARIS GAGNÉS !
        combi.status = 'won';
        await combi.save();

const user = await getUser(combi.userId);
user.balance += combi.potentialWin;
user.stats.totalBets++;
user.stats.wonBets++;
const betRecord = await Bet.findOne({ messageId: messageId });
if (betRecord) {
  const streakBonus = await handleWinstreak(user, betRecord.channelId, {
    question: `Combiné ${combi.bets.length} matchs`,
    option: `Cote ${combi.totalOdds.toFixed(2)}x`,
    amount: combi.totalStake,
    winnings: combi.potentialWin,
    type: 'combi'
  });
}

// ⭐ AJOUTER À L'HISTORIQUE
user.history.push({
  betId: combi.combiId,
  question: `Combiné ${combi.bets.length} matchs`,
  option: `Cote ${combi.totalOdds.toFixed(2)}x`,
  amount: combi.totalStake,
  winnings: combi.potentialWin,
  result: 'won',
  timestamp: new Date()
});

{
  // ⭐ VÉRIFICATION PALIER
  const betRecord = await Bet.findOne({ messageId: messageId });
  if (betRecord) {
    await handleMilestone(user, betRecord.channelId);
  }
}

await user.save();

        // ⭐ NOTIFICATION COMBINÉ COMPLET GAGNÉ
        const bet = await Bet.findOne({ messageId: messageId });
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
        console.log(`⏳ Combiné en progression (${combi.resolvedBets}/${combi.bets.length})`);
        
        // ⭐ NOTIFICATION PROGRESSION
        combiNotifications.push({
          userId: combi.userId,
          username: combi.username,
          type: 'progress',
          question: betInCombi.question,
          optionName: betInCombi.optionName,
          resolved: combi.resolvedBets,
          total: combi.bets.length,
          stake: combi.totalStake,
          odds: combi.totalOdds,
          potentialWin: combi.potentialWin
        });

        await combi.save();
      }
    }

    return combiNotifications;
  } catch (error) {
    console.error('❌ Erreur vérification combinés:', error);
    return [];
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

if (action === 'sor') {
  // ⭐ CORRECTION : Le parsing était incorrect
  // customId format: "sor_continue_123456789" ou "sor_cashout_123456789" ou "sor_cancel_123456789"
  const subaction = interaction.customId.split('_')[1]; // 'continue', 'cashout' ou 'cancel'
  const userId = interaction.customId.split('_')[2]; // L'ID utilisateur

  console.log('🔍 DEBUG SOR BUTTON');
  console.log('customId complet:', interaction.customId);
  console.log('subaction:', subaction);
  console.log('userId from button:', userId);
  console.log('interaction.user.id:', interaction.user.id);
  console.log('Match?', interaction.user.id === userId);

  // Vérifier que c'est bien le joueur
  if (interaction.user.id !== userId) {
    return interaction.reply({ content: '❌ Ce jeu n\'est pas le vôtre !', ephemeral: true });
  }

  const game = activeSafeOrRiskGames.get(userId);

  if (!game) {
    return interaction.reply({ content: '❌ Partie introuvable ou expirée.', ephemeral: true });
  }

  const multipliers = getSafeOrRiskMultipliers();

  // ❌ ANNULER LA PARTIE
  if (subaction === 'cancel') {
    // Vérifier qu'on est bien au tour 1
    if (game.round !== 1) {
      return interaction.reply({ 
        content: '❌ Impossible d\'annuler ! Vous pouvez seulement annuler au tour 1.', 
        ephemeral: true 
      });
    }

    // Rembourser le joueur
    const user = await getUser(userId);
    user.balance += game.stake;
    await user.save();

    // Supprimer la partie
    activeSafeOrRiskGames.delete(userId);

    const cancelEmbed = new EmbedBuilder()
      .setColor('#808080')
      .setTitle('🚫 Partie Annulée')
      .setDescription(
        `Vous avez annulé votre partie de Safe or Risk.\n\n` +
        `💰 **Mise remboursée :** ${game.stake}€\n` +
        `💳 **Solde actuel :** ${user.balance}€`
      )
      .setFooter({ text: '🎲 Relancez avec !safe-or-risk [montant]' })
      .setTimestamp();

    await interaction.update({ embeds: [cancelEmbed], components: [] });
    
    console.log(`🚫 ${interaction.user.tag} annule sa partie (remboursé ${game.stake}€)`);
    return;
  }

  // ✅ ENCAISSER
  if (subaction === 'cashout') {
    // ⭐ EMPÊCHER L'ENCAISSEMENT AU TOUR 1
    if (game.round === 1) {
      return interaction.reply({ 
        content: '❌ Vous devez d\'abord risquer au moins 1 tour ! Impossible d\'encaisser au tour 1.', 
        ephemeral: true 
      });
    }

    const roundData = multipliers[game.round - 1];
    const winnings = Math.floor(game.stake * roundData.multiplier);
    const profit = winnings - game.stake;

    // Créditer le joueur
    const user = await getUser(userId);
    user.balance += winnings;
    user.stats.totalBets++;
    user.stats.wonBets++;
    user.history.push({
      betId: `sor_${Date.now()}`,
      question: `Safe or Risk (Tour ${game.round})`,
      option: `Encaissé x${roundData.multiplier}`,
      amount: game.stake,
      winnings: winnings,
      result: 'won',
      timestamp: new Date()
    });

    // ⭐ VÉRIFICATION PALIER
await handleMilestone(user, interaction.channel.id);
    
    await user.save();

    // Supprimer la partie
    activeSafeOrRiskGames.delete(userId);

    const winEmbed = new EmbedBuilder()
      .setColor('#00FF00')
      .setTitle('✅ ENCAISSÉ AVEC SUCCÈS !')
      .setDescription(
        `🎉 **Félicitations !** Vous avez sécurisé vos gains au **tour ${game.round}** !\n\n` +
        `💰 **Mise de départ :** ${game.stake}€\n` +
        `📊 **Multiplicateur :** x${roundData.multiplier}\n` +
        `💎 **Gain total :** **${winnings}€**\n` +
        `💸 **Profit :** **+${profit}€**\n\n` +
        `💳 **Nouveau solde :** ${user.balance}€`
      )
      .setFooter({ text: '🎲 Rejouez avec !safe-or-risk [montant]' })
      .setTimestamp();

    await interaction.update({ embeds: [winEmbed], components: [] });
    
    console.log(`✅ ${interaction.user.tag} encaisse ${winnings}€ au tour ${game.round}`);
    return;
  }

  // 🎲 CONTINUER (RISQUER)
  if (subaction === 'continue') {
    const currentRoundData = multipliers[game.round - 1];
    
    // Tirer au sort (basé sur winChance)
    const random = Math.random() * 100;
    const success = random < currentRoundData.winChance;

    await interaction.deferUpdate();

    if (!success) {
      // 💥 BOOM - TOUT PERDU
      const user = await getUser(userId);
      user.stats.totalBets++;
      user.stats.lostBets++;
      user.history.push({
        betId: `sor_${Date.now()}`,
        question: `Safe or Risk (Tour ${game.round})`,
        option: `Boom x${currentRoundData.multiplier}`,
        amount: game.stake,
        winnings: 0,
        result: 'lost',
        timestamp: new Date()
      });
      await user.save();

      activeSafeOrRiskGames.delete(userId);

      const loseEmbed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('💥 BOOOOM ! 💥')
        .setDescription(
          `😱 **Vous avez tout perdu au tour ${game.round} !**\n\n` +
          `💸 **Mise perdue :** ${game.stake}€\n` +
          `📊 **Vous étiez à :** x${currentRoundData.multiplier}\n` +
          `💔 **Vous auriez pu gagner :** ${Math.floor(game.stake * currentRoundData.multiplier)}€\n\n` +
          `🎲 **Chance d'échec :** ${100 - currentRoundData.winChance}%\n` +
          `💳 **Solde actuel :** ${user.balance}€`
        )
        .setFooter({ text: '🔄 Retentez votre chance avec !safe-or-risk [montant]' })
        .setTimestamp();

      await interaction.editReply({ embeds: [loseEmbed], components: [] });
      
      console.log(`💥 ${interaction.user.tag} explose au tour ${game.round} (perte: ${game.stake}€)`);
      return;
    }

    // ✅ SUCCÈS - PASSAGE AU TOUR SUIVANT
    game.round++;

    if (game.round > 10) {
      // 🏆 VICTOIRE TOTALE (tous les tours passés)
      const finalWinnings = Math.floor(game.stake * 30); // x30 au tour 10
      const profit = finalWinnings - game.stake;

      const user = await getUser(userId);
      user.balance += finalWinnings;
      user.stats.totalBets++;
      user.stats.wonBets++;
      user.history.push({
        betId: `sor_${Date.now()}`,
        question: `Safe or Risk (JACKPOT)`,
        option: `Complété x30`,
        amount: game.stake,
        winnings: finalWinnings,
        result: 'won',
        timestamp: new Date()
      });
      
// ⭐ VÉRIFICATION PALIER
await handleMilestone(user, interaction.channel.id);
      
      await user.save();

      activeSafeOrRiskGames.delete(userId);

      const jackpotEmbed = new EmbedBuilder()
        .setColor('#FFD700')
        .setTitle('🏆🎰 JACKPOT ULTIME ! 🎰🏆')
        .setDescription(
          `🎉🎉🎉 **INCROYABLE !** 🎉🎉🎉\n\n` +
          `Vous avez complété **LES 10 TOURS** sans exploser !\n\n` +
          `💰 **Mise :** ${game.stake}€\n` +
          `⭐ **Multiplicateur final :** **x30**\n` +
          `💎 **GAIN TOTAL :** **${finalWinnings}€**\n` +
          `💸 **Profit :** **+${profit}€**\n\n` +
          `💳 **Nouveau solde :** ${user.balance}€`
        )
        .setFooter({ text: `🎊 Bravo ${interaction.user.tag} ! Performance exceptionnelle ! 🎊` })
        .setTimestamp();

      await interaction.editReply({ embeds: [jackpotEmbed], components: [] });
      
      console.log(`🏆 ${interaction.user.tag} remporte le JACKPOT : ${finalWinnings}€`);
      return;
    }

    // Mettre à jour l'affichage pour le tour suivant
    const nextRoundData = multipliers[game.round - 1];
    const nextEmbed = createSafeOrRiskEmbed(game, nextRoundData);

    // ⭐ À partir du tour 2, on peut encaisser OU continuer
    const nextRow = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`sor_continue_${userId}`)
          .setLabel(`🎲 RISQUER (${nextRoundData.winChance}% chance)`)
          .setStyle(ButtonStyle.Danger)
          .setEmoji('🎲'),
        new ButtonBuilder()
          .setCustomId(`sor_cashout_${userId}`)
          .setLabel(`✅ ENCAISSER ${Math.floor(game.stake * nextRoundData.multiplier)}€`)
          .setStyle(ButtonStyle.Success)
          .setEmoji('💰')
      );

    await interaction.editReply({ embeds: [nextEmbed], components: [nextRow] });
    
    console.log(`✅ ${interaction.user.tag} passe au tour ${game.round} (x${nextRoundData.multiplier})`);
  }
}
    
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

  if (action === 'quick' && params[0] === 'cancel' && params[1] === 'combi') {
    const combiId = params[2];
    
    console.log('🔍 Tentative d\'annulation combiné:', combiId);
    
    const combi = await Combi.findOne({ combiId, userId: interaction.user.id });

    if (!combi) {
      return interaction.reply({ content: '❌ Combiné introuvable ou vous n\'en êtes pas le propriétaire.', ephemeral: true });
    }

    if (combi.status !== 'confirmed') {
      return interaction.reply({ content: '❌ Ce combiné ne peut plus être annulé (statut: ' + combi.status + ').', ephemeral: true });
    }

    // Vérifier qu'aucun pari du combiné n'est résolu
    for (const bet of combi.bets) {
      const betData = await Bet.findOne({ messageId: bet.messageId });
      if (betData && betData.status === 'resolved') {
        return interaction.reply({ content: '❌ Impossible d\'annuler : au moins un match est déjà terminé.', ephemeral: true });
      }
    }

    // Rembourser
    const user = await getUser(interaction.user.id);
    user.balance += combi.totalStake;
    await user.save();

    combi.status = 'cancelled';
    await combi.save();

    const embed = new EmbedBuilder()
      .setColor('#FFA500')
      .setTitle('🚫 Combiné Annulé')
      .setDescription(`Votre combiné a été annulé avec succès.`)
      .addFields(
        { name: '💰 Montant remboursé', value: `${combi.totalStake}€`, inline: true },
        { name: '💳 Nouveau solde', value: `${user.balance}€`, inline: true }
      )
      .setFooter({ text: `ID: ${combiId}` })
      .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
    
    console.log(`✅ Combiné ${combiId} annulé pour ${interaction.user.tag}`);
    
    // Désactiver le bouton dans le message original
    try {
      const disabledRow = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId('disabled')
            .setLabel('✅ Combiné annulé')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true)
        );
      
      await interaction.message.edit({ components: [disabledRow] });
    } catch (e) {
      console.log('⚠️ Impossible de désactiver le bouton');
    }
    
    return; // Important pour ne pas continuer le traitement
  }

    if (action === 'leaderboard') {
      const sortBy = params[0];
      
      const users = await User.find({
        userId: { $regex: /^[0-9]{17,19}$/ } // ⭐ Garde seulement les vrais IDs Discord
      });
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

      console.log(`✅ Pari
      enregistré pour ${interaction.user.tag} - Total parieurs: ${Object.keys(updateResult.bettors).length}`);

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
  .setDescription(`Vous avez misé **${amount}€** sur **${bet.options[optionIndex].name}**`)
  .addFields(
    { name: '📊 Match', value: bet.question },
    { name: '🎯 Cote', value: `${odds}x`, inline: true },
    { name: '💎 Gain potentiel', value: `${potentialWin}€`, inline: true },
    { name: '💸 Profit potentiel', value: `+${potentialWin - amount}€`, inline: true },
    { name: '💳 Nouveau solde', value: `${user.balance}€`, inline: true }
  );

// Afficher la clôture si disponible
if (bet.closingTime) {
  const timeUntilClosing = new Date(bet.closingTime).getTime() - Date.now();
  const minutesLeft = Math.floor(timeUntilClosing / 60000);
  
  if (minutesLeft > 0) {
    successEmbed.addFields({
      name: '⏰ Clôture des paris',
      value: `Dans **${minutesLeft} minutes** (<t:${Math.floor(new Date(bet.closingTime).getTime() / 1000)}:R>)`,
      inline: false
    });
  }
}

successEmbed.setFooter({ text: '🍀 Bonne chance ! Utilisez !mes-paris pour suivre vos paris' });

// ✅ ENVOYER UNIQUEMENT EN MESSAGE PRIVÉ
try {
  await interaction.user.send({ embeds: [successEmbed] });
  
  await interaction.reply({ 
    content: '✅ Pari enregistré ! Vérifiez vos messages privés 📬', 
    ephemeral: true 
  });
} catch (error) {
  await interaction.reply({ 
    content: '⚠️ Impossible de vous envoyer un message privé.\n\n✅ Votre pari a quand même été enregistré !', 
    ephemeral: true 
  });
}
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
    const users = await User.find({
    userId: { $regex: /^[0-9]{17,19}$/ } // ⭐ Garde seulement les vrais IDs Discord
  });
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

  if (command === '!roulette' || command === '!spin' || command === '!roue') {
  // Vérifier si l'utilisateur peut tourner aujourd'hui
  const canSpin = await canSpinToday(message.author.id);
  
  if (!canSpin) {
    const spinData = await DailySpin.findOne({ userId: message.author.id });
    const nextSpin = new Date(spinData.lastSpin);
    nextSpin.setDate(nextSpin.getDate() + 1);
    nextSpin.setHours(0, 0, 0, 0);
    
    const hoursLeft = Math.ceil((nextSpin - Date.now()) / (1000 * 60 * 60));
    
    return message.reply({
      embeds: [
        new EmbedBuilder()
          .setColor('#FF6B6B')
          .setTitle('🎰 Roulette Quotidienne')
          .setDescription(`❌ Vous avez déjà tourné aujourd'hui !`)
          .addFields({
            name: '⏰ Prochaine rotation disponible',
            value: `Dans **${hoursLeft}h** environ\n<t:${Math.floor(nextSpin.getTime() / 1000)}:R>`
          })
          .setFooter({ text: 'Revenez demain pour retenter votre chance !' })
      ]
    });
  }
  
  // Animation de la roulette
  const loadingEmbed = new EmbedBuilder()
    .setColor('#FFA500')
    .setTitle('🎰 Roulette Quotidienne')
    .setDescription('🎲 **La roue tourne...**\n\n```\n🔄 En cours...\n```')
    .setFooter({ text: 'Bonne chance !' });
  
  const loadingMsg = await message.reply({ embeds: [loadingEmbed] });
  
  // Attendre 2 secondes pour l'effet de suspense
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // Tourner la roulette
  const reward = spinRoulette();
  
  // Créditer l'utilisateur
  const user = await getUser(message.author.id);
  user.balance += reward;
  await user.save();
  
  // Enregistrer le spin
  await updateLastSpin(message.author.id);
  
  // Déterminer la couleur selon la récompense
  let embedColor = '#A8E6CF'; // Vert clair par défaut
  let emojiReward = '💰';
  
  if (reward >= 50) {
    embedColor = '#FFD700'; // Or
    emojiReward = '🎊';
  } else if (reward >= 20) {
    embedColor = '#FF69B4'; // Rose
    emojiReward = '✨';
  } else if (reward >= 10) {
    embedColor = '#87CEEB'; // Bleu ciel
    emojiReward = '💎';
  }
  
  // Message de résultat
  const resultEmbed = new EmbedBuilder()
    .setColor(embedColor)
    .setTitle('🎰 Roulette Quotidienne - Résultat !')
    .setDescription(
      `${emojiReward} **Félicitations <@${message.author.id}> !** ${emojiReward}\n\n` +
      `Vous avez gagné **${reward}€** !\n\n` +
      `💳 **Nouveau solde :** ${user.balance}€`
    )
    .addFields({
      name: '📊 Probabilités',
      value: 
        '• 1€ (30%)\n' +
        '• 5€ (25%)\n' +
        '• 8€ (15%)\n' +
        '• 10€ (10%)\n' +
        '• 20€ (8%)\n' +
        '• 30€ (6%)\n' +
        '• 50€ (5%)\n' +
        '• 80€ (1%) 🌟',
      inline: false
    })
    .setFooter({ text: 'Revenez demain pour retourner la roue !' })
    .setTimestamp();
  
  await loadingMsg.edit({ embeds: [resultEmbed] });
}

if (command === '!profil' || command === '!profile' || command === '!stats') {
  const targetUser = message.mentions.users.first() || message.author;
  const user = await getUser(targetUser.id);
  const winrate = await calculateWinrate(targetUser.id);
  
  // 🆕 CALCUL DU CLASSEMENT
  const allUsersByBalance = await User.find({
    userId: { $regex: /^[0-9]{17,19}$/ }
  }).sort({ balance: -1 });
  
  const allUsersByWinrate = await User.find({
    userId: { $regex: /^[0-9]{17,19}$/ },
    'stats.totalBets': { $gt: 0 }
  }).sort({ 'stats.wonBets': -1 });
  
  const rankBalance = allUsersByBalance.findIndex(u => u.userId === targetUser.id) + 1;
  const rankWinrate = allUsersByWinrate.findIndex(u => u.userId === targetUser.id) + 1;
  
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
      { name: '⚖️ Ratio', value: `${user.stats.wonBets}/${user.stats.lostBets}`, inline: true },
      // 🆕 CLASSEMENT
      { name: '🏆 Classement (Solde)', value: `#${rankBalance}/${allUsersByBalance.length}`, inline: true },
      { name: '📈 Classement (Victoires)', value: rankWinrate > 0 ? `#${rankWinrate}/${allUsersByWinrate.length}` : 'N/A', inline: true },
      { name: '\u200b', value: '\u200b', inline: true }
    )
    .setTimestamp();
    
  // Affichage des paliers
  const milestonesText = user.milestonesReached && user.milestonesReached.length > 0
    ? user.milestonesReached.sort((a, b) => b - a).slice(0, 5).map(m => `✅ ${m} paris`).join('\n')
    : 'Aucun palier atteint';

  const nextMilestone = getNextMilestone(user.stats.wonBets);

  embed.addFields(
    { name: '🏆 Derniers paliers', value: milestonesText, inline: true },
    { name: '🎯 Prochain palier', value: `${nextMilestone} paris`, inline: true },
    { name: '\u200b', value: '\u200b', inline: true },
     { name: '🔥 Winstreak actuelle', value: `${user.currentStreak}`, inline: true },
  { name: '🏆 Meilleur record', value: `${user.bestStreak}`, inline: true },
  { name: '💰 Bonus actif', value: user.currentStreak >= 3 ? '✅ +5€/victoire' : '❌', inline: true }
  );

  if (recentHistory.length > 0) {
    let historyText = '';
    for (const h of recentHistory) {
      const resultEmoji = h.result === 'won' ? '✅' : '❌';
      const isCombi = h.betId && h.betId.startsWith('combi_');
      
      if (isCombi) {
        const profit = h.result === 'won' ? `+${h.winnings - h.amount}€` : `-${h.amount}€`;
        historyText += `${resultEmoji} 🎰 **${h.question}** – ${h.option} – Mise: ${h.amount}€ – ${profit}\n`;
      } else {
        const profit = h.result === 'won' ? `+${h.winnings - h.amount}€` : `-${h.amount}€`;
        historyText += `${resultEmoji} **${h.question}** – ${h.option} (${h.amount}€) ${profit}\n`;
      }
    }
    embed.addFields({ name: '📜 Historique Récent', value: historyText, inline: false });
  }

  message.reply({ embeds: [embed] });
}

  // ⚠️ COMMANDE TEMPORAIRE - À SUPPRIMER APRÈS USAGE
if (command === '!reset-database-admin') {
  // ⚠️ SÉCURITÉ : Vérifier que c'est bien VOUS
  if (message.author.id !== '525442874649608225') {
    return message.reply('❌ Accès refusé.');
  }

  const confirmMsg = await message.reply('⚠️ **ATTENTION !** Cette commande va SUPPRIMER TOUTES LES DONNÉES.\nRéagissez avec ✅ dans les 30 secondes pour confirmer.');
  
  await confirmMsg.react('✅');
  
  const filter = (reaction, user) => reaction.emoji.name === '✅' && user.id === message.author.id;
  const collector = confirmMsg.createReactionCollector({ filter, time: 30000, max: 1 });
  
  collector.on('collect', async () => {
    try {
      // Supprimer toutes les données
      const deletedUsers = await User.deleteMany({});
      const deletedBets = await Bet.deleteMany({});
      const deletedCombis = await Combi.deleteMany({});
      const deletedSpins = await DailySpin.deleteMany({});
      
      const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('🗑️ Base de données réinitialisée')
        .addFields(
          { name: 'Utilisateurs supprimés', value: `${deletedUsers.deletedCount}`, inline: true },
          { name: 'Paris supprimés', value: `${deletedBets.deletedCount}`, inline: true },
          { name: 'Combinés supprimés', value: `${deletedCombis.deletedCount}`, inline: true },
          { name: 'Spins supprimés', value: `${deletedSpins.deletedCount}`, inline: true }
        )
        .setFooter({ text: '✅ Toutes les données ont été effacées. Redémarrez le bot.' })
        .setTimestamp();
      
      await message.reply({ embeds: [embed] });
      
      console.log('🗑️ BASE DE DONNÉES RÉINITIALISÉE');
    } catch (error) {
      console.error('Erreur reset:', error);
      message.reply('❌ Erreur lors de la réinitialisation.');
    }
  });
  
  collector.on('end', collected => {
    if (collected.size === 0) {
      confirmMsg.reply('⏱️ Temps écoulé. Réinitialisation annulée.');
    }
  });
}

  if (command === '!streak-history' || command === '!sh') {
  const user = await getUser(message.author.id);
  
  if (!user.streakHistory || user.streakHistory.length === 0) {
    return message.reply('📊 Vous n\'avez aucun historique de winstreak.');
  }

  // Prendre les 5 dernières streaks terminées
  const completedStreaks = user.streakHistory
    .filter(s => s.endedAt)
    .sort((a, b) => new Date(b.endedAt) - new Date(a.endedAt))
    .slice(0, 5);

  if (completedStreaks.length === 0) {
    return message.reply('📊 Aucune winstreak terminée pour le moment.');
  }

  const embed = new EmbedBuilder()
    .setColor('#FFD700')
    .setTitle('📜 Votre Historique de Winstreaks')
    .setDescription(`Vos ${completedStreaks.length} dernières séries de victoires :\n`)
    .setTimestamp();

  for (const streak of completedStreaks) {
    const totalWinnings = streak.bets.reduce((sum, b) => sum + (b.winnings || 0), 0);
    const totalStake = streak.bets.reduce((sum, b) => sum + (b.amount || 0), 0);
    const profit = totalWinnings - totalStake;
    const bonusEarned = streak.streak >= 3 ? (streak.streak - 2) * 5 : 0;

    let fieldValue = `**Durée :** ${streak.streak} victoires 🔥\n`;
    fieldValue += `**Gains totaux :** ${totalWinnings}€\n`;
    fieldValue += `**Profit :** +${profit}€\n`;
    if (bonusEarned > 0) {
      fieldValue += `**Bonus streak :** +${bonusEarned}€ 🎁\n`;
    }
    fieldValue += `**Terminée le :** ${new Date(streak.endedAt).toLocaleDateString('fr-FR')}\n\n`;
    
    fieldValue += `**Paris gagnés :**\n`;
    streak.bets.forEach((b, i) => {
      const typeEmoji = b.type === 'combi' ? '🎰' : '💰';
      fieldValue += `${i + 1}. ${typeEmoji} ${b.question} (${b.amount}€ → ${b.winnings}€)\n`;
    });

    embed.addFields({
      name: `🔥 Série de ${streak.streak} victoires`,
      value: fieldValue,
      inline: false
    });
  }

  embed.setFooter({ text: '💡 Votre record actuel : ' + user.bestStreak + ' victoires' });

  message.reply({ embeds: [embed] });
}

  if (command === '!pari' || command === '!p') {
    const betMessageId = args[1];
    const optionNum = parseInt(args[2]);
    const amount = parseInt(args[3]);

    // Vérifications des arguments
    if (!betMessageId || isNaN(optionNum) || isNaN(amount)) {
      return message.reply(
        '❌ Format incorrect.\n' +
        '**Usage :** `!pari [id] [option] [montant]`\n' +
        '**Exemple :** `!pari 123456789 1 50`\n\n' +
        '💡 Utilisez `!paris` pour voir les IDs et options disponibles.'
      );
    }

    if (amount <= 0) {
      return message.reply('❌ Le montant doit être supérieur à 0.');
    }

    // Charger le pari
    const bet = await Bet.findOne({ messageId: betMessageId });

    if (!bet) {
      return message.reply(
        `❌ Pari introuvable : \`${betMessageId}\`\n` +
        `Utilisez \`!paris\` pour voir les paris actifs.`
      );
    }

    if (bet.status === 'locked') {
      return message.reply('❌ Les paris sont clôturés. Le match est en cours !');
    }

    if (bet.status !== 'open') {
      return message.reply(`❌ Ce pari est fermé.\nQuestion : "${bet.question}"`);
    }

    const optionIndex = optionNum - 1;
    if (optionIndex < 0 || optionIndex >= bet.options.length) {
      return message.reply(
        `❌ Option invalide pour le pari "${bet.question}"\n` +
        `Vous avez choisi l'option **${optionNum}**, mais ce pari a **${bet.options.length} option(s)**.\n` +
        `Options disponibles :\n` +
        bet.options.map((o, i) => `  ${i + 1}. ${o.name} (cote ${bet.initialOdds[i]}x)`).join('\n')
      );
    }

    // Vérifier si déjà parié
    if (bet.bettors && bet.bettors[message.author.id]) {
      return message.reply(
        `❌ Vous avez déjà parié sur ce match !\n` +
        `Match : "${bet.question}"\n` +
        `Votre pari : **${bet.bettors[message.author.id].amount}€** sur **${bet.options[bet.bettors[message.author.id].option].name}**`
      );
    }

    // Vérifier le solde
    const user = await getUser(message.author.id);
    if (user.balance < amount) {
      return message.reply(`❌ Solde insuffisant. Vous avez **${user.balance}€**.`);
    }

    const odds = bet.initialOdds[optionIndex];
    const potentialWin = calculatePotentialWin(amount, odds);

    // Déduire du solde
    user.balance -= amount;
    await user.save();

    // Enregistrer le pari (opération atomique)
    const updateResult = await Bet.findOneAndUpdate(
      { 
        messageId: betMessageId,
        [`bettors.${message.author.id}`]: { $exists: false }
      },
      { 
        $set: { 
          [`bettors.${message.author.id}`]: {
            option: optionIndex,
            amount: amount,
            username: message.author.tag,
            odds: odds
          }
        },
        $inc: { totalPool: amount }
      },
      { new: true }
    );

    if (!updateResult) {
      // Rembourser si échec
      user.balance += amount;
      await user.save();
      return message.reply('❌ Erreur : vous avez déjà parié ou le pari n\'existe plus.');
    }

    console.log(`✅ ${message.author.tag} a parié ${amount}€ via !pari`);

    // Mettre à jour le message Discord
    try {
      const channel = await client.channels.fetch(bet.channelId);
      const betMessage = await channel.messages.fetch(betMessageId);
      
      const bettorsCount = Object.keys(updateResult.bettors).length;
      
      const fields = betMessage.embeds[0].fields.filter(f => !['💰 Comment parier ?', '📈 Statut', '💵 Total des mises', '👥 Parieurs'].includes(f.name));
      fields.push(
        { name: '💰 Comment parier ?', value: 'Cliquez sur le bouton OU utilisez `!pari [id] [option] [montant]`' },
        { name: '📈 Statut', value: updateResult.status === 'open' ? '🟢 En cours' : '🔒 Clôturé', inline: true },
        { name: '💵 Total des mises', value: `${updateResult.totalPool}€`, inline: true },
        { name: '👥 Parieurs', value: `${bettorsCount}`, inline: true }
      );
      
      const updatedEmbed = EmbedBuilder.from(betMessage.embeds[0]).setFields(fields);
      await betMessage.edit({ embeds: [updatedEmbed] });
      
      await betMessage.reply(`💰 **<@${message.author.id}>** a parié **${amount}€** sur **${bet.options[optionIndex].name}** (cote ${odds}x) — Gain potentiel : **${potentialWin}€**`);
    } catch (error) {
      console.error('Erreur mise à jour message:', error);
    }

    // Confirmation privée
const successEmbed = new EmbedBuilder()
  .setColor('#00FF00')
  .setTitle('✅ Pari Placé !')
  .setDescription(`Vous avez misé **${amount}€** sur **${bet.options[optionIndex].name}**`)
  .addFields(
    { name: '📊 Match', value: bet.question },
    { name: '🎯 Cote', value: `${odds}x`, inline: true },
    { name: '💎 Gain potentiel', value: `${potentialWin}€`, inline: true },
    { name: '💸 Profit potentiel', value: `+${potentialWin - amount}€`, inline: true },
    { name: '💳 Nouveau solde', value: `${user.balance}€`, inline: true }
  );

// Afficher la clôture si disponible
if (bet.closingTime) {
  const timeUntilClosing = new Date(bet.closingTime).getTime() - Date.now();
  const minutesLeft = Math.floor(timeUntilClosing / 60000);
  
  if (minutesLeft > 0) {
    successEmbed.addFields({
      name: '⏰ Clôture des paris',
      value: `Dans **${minutesLeft} minutes** (<t:${Math.floor(new Date(bet.closingTime).getTime() / 1000)}:R>)`,
      inline: false
    });
  }
}

successEmbed.setFooter({ text: '🍀 Bonne chance ! Utilisez !mes-paris pour suivre vos paris' });

// ✅ ENVOYER EN MESSAGE PRIVÉ (DM) au lieu de reply public
try {
  await message.author.send({ embeds: [successEmbed] });
  // Confirmer avec un petit message public qui sera supprimé
  const confirmMsg = await message.reply('✅ Pari enregistré ! Vérifiez vos messages privés pour le récapitulatif.');
  setTimeout(() => confirmMsg.delete().catch(() => {}), 5000);
} catch (error) {
  // Si les DM sont fermés, envoyer en ephemeral (mais on ne peut pas avec message.reply)
  // Donc on envoie juste un message court qui sera supprimé
  const fallbackMsg = await message.reply({ embeds: [successEmbed] });
  setTimeout(() => fallbackMsg.delete().catch(() => {}), 10000);
}
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
  
if (command === '!topstreak' || command === '!top-streak' || command === '!streaks') {
  // Récupérer tous les utilisateurs avec leur meilleur streak
  const allUsers = await User.find({
    userId: { $regex: /^[0-9]{17,19}$/ },
    bestStreak: { $gt: 0 }
  }).sort({ bestStreak: -1 }).limit(5);

  if (allUsers.length === 0) {
    return message.reply('📊 Aucun record de winstreak enregistré pour le moment.');
  }

  const embed = new EmbedBuilder()
    .setColor('#FF6B00')
    .setTitle('🔥 TOP 5 - Records de Winstreak')
    .setDescription('Les meilleures séries de victoires consécutives !\n')
    .setTimestamp();

  let description = '';
  
  for (let i = 0; i < allUsers.length; i++) {
    const user = allUsers[i];
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `**${i + 1}.**`;
    const currentStreakIndicator = user.currentStreak > 0 ? ` 🔥 (${user.currentStreak} en cours)` : '';
    
    description += `${medal} <@${user.userId}> — **${user.bestStreak} victoires**${currentStreakIndicator}\n`;
  }

  embed.setDescription(description);

  // Afficher la streak actuelle du joueur qui demande
  const requestingUser = await getUser(message.author.id);
  
  embed.addFields({
    name: '📈 Votre Winstreak',
    value: 
      `**Actuelle :** ${requestingUser.currentStreak} 🔥\n` +
      `**Record :** ${requestingUser.bestStreak}\n` +
      `**Bonus actuel :** ${requestingUser.currentStreak >= 3 ? '+5€ par victoire ✅' : `Plus que ${3 - requestingUser.currentStreak} victoire(s) pour le bonus`}`,
    inline: false
  });

  embed.setFooter({ text: '💡 Gagnez 3 paris d\'affilée pour débloquer +5€ par victoire !' });

  message.reply({ embeds: [embed] });
}
  
if (command === '!safe-or-risk' || command === '!sor' || command === '!risk') {
  const amount = parseInt(args[1]);

  if (!amount || isNaN(amount) || amount <= 0) {
    return message.reply(
      '❌ **Format incorrect !**\n\n' +
      '📋 **Usage :** `!safe-or-risk <montant>`\n' +
      '📌 **Exemple :** `!safe-or-risk 50`\n\n' +
      '🎲 **Règles du jeu :**\n' +
      '• Chaque tour multiplie tes gains\n' +
      '• Tu peux encaisser à tout moment\n' +
      '• Ou risquer de continuer...\n' +
      '• Mais attention : plus tu montes, plus tu risques de **TOUT PERDRE** !\n\n' +
      '🔢 **Alias :** `!sor`, `!risk`'
    );
  }

  // Vérifier si le joueur a déjà une partie en cours
  if (activeSafeOrRiskGames.has(message.author.id)) {
    return message.reply('❌ Vous avez déjà une partie en cours ! Terminez-la avant d\'en commencer une nouvelle.');
  }

  // Vérifier le solde
  const user = await getUser(message.author.id);
  if (user.balance < amount) {
    return message.reply(`❌ Solde insuffisant. Vous avez **${user.balance}€**.`);
  }

  // Déduire la mise
  user.balance -= amount;
  await user.save();

  // Créer la partie
  const multipliers = getSafeOrRiskMultipliers();
  const game = {
    stake: amount,
    currentMultiplier: 1,
    round: 1,
    userId: message.author.id,
    username: message.author.tag
  };

  const roundData = multipliers[0]; // Tour 1
  const embed = createSafeOrRiskEmbed(game, roundData);

  // Au tour 1, on ne peut QUE risquer ou ANNULER (pas d'encaissement possible)
  const row = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(`sor_continue_${message.author.id}`)
        .setLabel(`🎲 RISQUER (${roundData.winChance}% chance)`)
        .setStyle(ButtonStyle.Danger)
        .setEmoji('🎲'),
      new ButtonBuilder()
        .setCustomId(`sor_cancel_${message.author.id}`)
        .setLabel('❌ ANNULER')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('🚫')
    );

  const gameMessage = await message.reply({ embeds: [embed], components: [row] });
  
  game.messageId = gameMessage.id;
  activeSafeOrRiskGames.set(message.author.id, game);

  console.log(`🎲 ${message.author.tag} lance Safe or Risk avec ${amount}€`);
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

  if (command === '!mes-paris' || command === '!mp') {
  const userId = message.author.id;
  
  // Récupérer tous les paris actifs
  const activeBets = await Bet.find({ status: { $in: ['open', 'locked'] } });
  
  // Filtrer ceux où l'utilisateur a parié
  const userBets = [];
  
  for (const bet of activeBets) {
    const bettorsObj = bet.bettors instanceof Map 
      ? Object.fromEntries(bet.bettors) 
      : (bet.bettors || {});
    
    // Chercher le pari de l'utilisateur (pas de combiné)
    for (const [bettorId, betData] of Object.entries(bettorsObj)) {
      if (bettorId === userId && !betData.isCombi) {
        userBets.push({
          messageId: bet.messageId,
          question: bet.question,
          option: bet.options[betData.option].name,
          optionIndex: betData.option,
          amount: betData.amount,
          odds: betData.odds,
          potentialWin: Math.floor(betData.amount * betData.odds),
          status: bet.status,
          closingTime: bet.closingTime,
          isBoosted: bet.isBoosted
        });
        break;
      }
    }
  }
  
  if (userBets.length === 0) {
    return message.reply('📭 Vous n\'avez aucun pari simple en cours.\n\n💡 Utilisez `!paris` pour voir les paris disponibles.');
  }
  
  const embed = new EmbedBuilder()
    .setColor('#FFD700')
    .setTitle('📊 Vos Paris En Cours')
    .setDescription(`Vous avez **${userBets.length}** pari(s) simple(s) en attente de résultat :\n`)
    .setFooter({ text: '💡 Les combinés sont visibles avec !mes-combis' })
    .setTimestamp();
  
  for (const userBet of userBets) {
    const statusEmoji = userBet.status === 'locked' ? '🔒' : '🟢';
    const statusText = userBet.status === 'locked' ? 'Clôturé (en cours)' : 'Ouvert';
    const boostedTag = userBet.isBoosted ? ' ⚡ BOOSTÉ' : '';
    const profit = userBet.potentialWin - userBet.amount;
    
    let fieldValue = `${statusEmoji} **Statut :** ${statusText}${boostedTag}\n`;
    fieldValue += `💰 **Mise :** ${userBet.amount}€\n`;
    fieldValue += `🎯 **Option :** ${userBet.option}\n`;
    fieldValue += `📊 **Cote :** ${userBet.odds}x\n`;
    fieldValue += `💎 **Gain potentiel :** **${userBet.potentialWin}€**\n`;
    fieldValue += `💸 **Profit potentiel :** **+${profit}€**\n`;
    
    if (userBet.closingTime) {
      fieldValue += `⏰ **Clôture :** <t:${Math.floor(new Date(userBet.closingTime).getTime() / 1000)}:R>\n`;
    }
    
    fieldValue += `\n🆔 ID : \`${userBet.messageId}\``;
    
    embed.addFields({
      name: `📌 ${userBet.question}`,
      value: fieldValue,
      inline: false
    });
  }
  
  // Calculer les totaux
  const totalStaked = userBets.reduce((sum, bet) => sum + bet.amount, 0);
  const totalPotential = userBets.reduce((sum, bet) => sum + bet.potentialWin, 0);
  const totalProfit = totalPotential - totalStaked;
  
  embed.addFields({
    name: '📈 Totaux',
    value: `💰 Total misé : **${totalStaked}€**\n💎 Gain potentiel total : **${totalPotential}€**\n💸 Profit potentiel : **+${totalProfit}€**`,
    inline: false
  });
  
  message.reply({ embeds: [embed] });
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
      // ⭐ SOLUTION SIMPLE : Date locale directe
      const closingDate = new Date();
      closingDate.setHours(targetHour, targetMinute, 0, 0);
      
      // Si l'heure est déjà passée aujourd'hui, passer à demain
      if (closingDate.getTime() <= Date.now()) {
        closingDate.setDate(closingDate.getDate() + 1);
      }
      
      closingTimestamp = closingDate.getTime();
      closingTime = closingDate;
      
      console.log(`🕐 Heure demandée : ${targetHour}h${targetMinute.toString().padStart(2, '0')}`);
      console.log(`📅 Clôture prévue : ${closingDate.toLocaleString('fr-FR')}`);
      console.log(`⏰ Dans ${Math.floor((closingTimestamp - Date.now()) / 60000)} minutes`);
    } else {
      return message.reply('❌ Heure invalide. Format: `21h30`');
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

// ⭐ Ajouter la mention @Parieur AVANT le message
const parieurRole = message.guild.roles.cache.find(role => role.name === 'Parieur');
if (parieurRole) {
  replyText = `${parieurRole} **Nouveau pari disponible !**\n\n` + replyText;
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
        const closingDate = new Date();
        closingDate.setHours(targetHour, targetMinute, 0, 0);
        
        if (closingDate.getTime() <= Date.now()) {
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
╔══════════════════════════════════════════════╗
║                                              ║
║    🔥 **${eventName}** 🔥    ║
║                                              ║
║         **COTE BOOSTÉE: ${oddsValue}x**         ║
║                                              ║
╚══════════════════════════════════════════════╝

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

  // ⭐ PRÉPARER LE CONTENU AVEC LA MENTION DU RÔLE
  const parieurRole = message.guild.roles.cache.find(role => role.name === 'Parieur');
  let messageContent = '';
  
  if (parieurRole) {
    messageContent = `${parieurRole} 🔥 **NOUVEAU PARI BOOSTÉ !** 🔥`;
  }
  
  // ⭐ ENVOYER LE MESSAGE UNE SEULE FOIS AVEC DES PLACEHOLDERS
  const betMessage = await message.channel.send({ 
    content: messageContent,
    embeds: [embed], 
    components: [row, adminRow] 
  });

  // ⭐ MAINTENANT, METTRE À JOUR AVEC LES VRAIS IDs
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

  // ⭐ MODIFIER LE MESSAGE AVEC LES BONS BOUTONS (SANS REENVOYER LE CONTENU)
  await betMessage.edit({ 
    components: [finalRow, finalAdminRow] 
  });

  // Créer le pari en DB
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

  // Configuration de la clôture automatique
  if (closingTime) {
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

  console.log(`⚡ Boost créé : ${betMessage.id} - ${eventName} (${oddsValue}x)`);
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
    // ⭐ VÉRIFIER SI C'EST UN PARI BOOSTÉ
if (bet.isBoosted) {
  return message.reply(
    `❌ **Impossible d'ajouter ce pari au combiné !**\n\n` +
    `Le pari "${bet.question}" est un **PARI BOOSTÉ** 🔥\n` +
    `Les paris boostés ne peuvent pas être combinés.\n\n` +
    `💡 Pariez directement dessus avec les boutons.`
  );
}
    
    const optionIndex = optionNum - 1;
    if (optionIndex < 0 || optionIndex >= bet.options.length) {
      return message.reply(
        `❌ Option invalide pour le pari "${bet.question}"\n` +
        `Vous avez choisi l'option **${optionNum}**, mais ce pari a **${bet.options.length} option(s)**.\n` +
        `Options disponibles : ${bet.options.map((o, i) => `${i + 1}. ${o.name}`).join(', ')}`
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
  const combis = await Combi.find({ userId: message.author.id }).sort({ createdAt: -1 }).limit(3);

  if (combis.length === 0) {
    return message.reply('🔭 Vous n\'avez aucun combiné enregistré.');
  }

  const embed = new EmbedBuilder()
    .setColor('#FFD700')
    .setTitle('🎰 Vos Combinés')
    .setDescription(`Vous avez **${combis.length}** combiné(s) récent(s) :`);

  let combiIndex = 0;

  for (const combi of combis) {
    combiIndex++;
    
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

    let fieldValue = `**ID :** \`${combi.combiId}\`\n`;
    fieldValue += `**Statut :** ${statusEmoji} ${statusText}\n`;
    fieldValue += `**Mise :** ${combi.totalStake}€ | **Cote :** ${combi.totalOdds.toFixed(2)}x | **Gain potentiel :** ${combi.potentialWin}€\n`;
    fieldValue += `**Progression :** ${combi.resolvedBets}/${combi.bets.length} matchs résolus\n`;
    
    // Barre de progression visuelle
    const progressBar = createProgressBar(combi.resolvedBets, combi.bets.length);
    const progressPercent = Math.floor((combi.resolvedBets / combi.bets.length) * 100);
    fieldValue += `${progressBar} ${progressPercent}%\n\n`;
    
    fieldValue += `**📋 Paris du combiné :**\n`;
    
    const processedBets = combi.processedBets || [];
    
    for (let i = 0; i < combi.bets.length; i++) {
      const b = combi.bets[i];
      
      let betStatusEmoji;
      
      if (combi.status === 'won') {
        betStatusEmoji = '✅';
      } else if (combi.status === 'lost') {
        const betData = await Bet.findOne({ messageId: b.messageId });
        
        if (betData && betData.status === 'resolved' && betData.winningOptions && Array.isArray(betData.winningOptions)) {
          const wasWinning = betData.winningOptions.includes(b.optionIndex);
          betStatusEmoji = wasWinning ? '✅' : '❌';
        } else if (betData && betData.status === 'resolved') {
          betStatusEmoji = '🚫';
        } else {
          betStatusEmoji = '⏳';
        }
      } else if (combi.status === 'confirmed') {
        betStatusEmoji = processedBets.includes(b.messageId) ? '✅' : '⏳';
      } else {
        betStatusEmoji = '🚫';
      }
      
      fieldValue += `${i + 1}. ${betStatusEmoji} ${b.question} → ${b.optionName} (${b.odds}x)\n`;
    }
    
    // 🆕 Indication pour annuler si le combiné est en cours
    if (combi.status === 'confirmed') {
      // Vérifier qu'aucun pari n'est résolu
      let canCancel = true;
      for (const bet of combi.bets) {
        const betData = await Bet.findOne({ messageId: bet.messageId });
        if (betData && betData.status === 'resolved') {
          canCancel = false;
          break;
        }
      }
      
      if (canCancel) {
        fieldValue += `\n💡 _Pour annuler : \`!combi-cancel ${combi.combiId}\`_`;
      }
    }

    embed.addFields({
      name: `🎰 Combiné #${combiIndex} - ${new Date(combi.createdAt).toLocaleString('fr-FR', { 
        timeZone: 'Europe/Paris',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit'
      })}`,
      value: fieldValue,
      inline: false
    });
  }

  embed.setFooter({ text: '💡 Utilisez !combi-cancel [ID] pour annuler un combiné en cours' });

  message.reply({ embeds: [embed] });
}

  if (command === '!topcotes' || command === '!bestcotes' || command === '!topcote') {
  // Récupérer tous les utilisateurs
  const allUsers = await User.find({
    userId: { $regex: /^[0-9]{17,19}$/ }
  });

  // Récupérer tous les paris gagnés (simples + combinés uniquement, PAS Safe or Risk)
  const allWinningBets = [];

  for (const user of allUsers) {
    if (!user.history || user.history.length === 0) continue;

    for (const bet of user.history) {
      // ❌ IGNORER Safe or Risk
      if (bet.question && bet.question.includes('Safe or Risk')) continue;
      
      // ✅ Seulement les paris gagnés
      if (bet.result !== 'won') continue;

      // Calculer la cote réelle
      const actualOdds = bet.amount > 0 ? (bet.winnings / bet.amount) : 0;

      // Vérifier si c'est un combiné
      const isCombi = bet.betId && bet.betId.startsWith('combi_');

      allWinningBets.push({
        userId: user.userId,
        question: bet.question,
        option: bet.option,
        amount: bet.amount,
        winnings: bet.winnings,
        profit: bet.winnings - bet.amount,
        odds: actualOdds,
        timestamp: bet.timestamp,
        isCombi: isCombi,
        type: isCombi ? 'Combiné' : 'Paris simple'
      });
    }
  }

  // Trier par cote décroissante
  allWinningBets.sort((a, b) => b.odds - a.odds);

  // Prendre le top 3
  const top3 = allWinningBets.slice(0, 3);

  if (top3.length === 0) {
    return message.reply('📊 Aucun pari gagné enregistré pour le moment.');
  }

  // Créer l'embed
  const embed = new EmbedBuilder()
    .setColor('#FFD700')
    .setTitle('🏆 TOP 3 - Meilleures Cotes Gagnées')
    .setDescription('Les paris avec les cotes les plus élevées qui ont été validés !\n')
    .setTimestamp();

  // Ajouter chaque pari du top 3
  for (let i = 0; i < top3.length; i++) {
    const bet = top3[i];
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : '🥉';
    const typeEmoji = bet.isCombi ? '🎰' : '💰';

    let fieldName = `${medal} #${i + 1} - Cote **${bet.odds.toFixed(2)}x** ${typeEmoji}`;
    
    let fieldValue = `**👤 Joueur :** <@${bet.userId}>\n`;
    fieldValue += `**📋 Type :** ${bet.type}\n`;
    fieldValue += `**🎯 Match :** ${bet.question}\n`;
    fieldValue += `**✅ Choix :** ${bet.option}\n`;
    fieldValue += `**💰 Mise :** ${bet.amount}€\n`;
    fieldValue += `**💎 Gain :** **${bet.winnings}€**\n`;
    fieldValue += `**💸 Profit :** **+${bet.profit}€**\n`;
    
    if (bet.timestamp) {
      fieldValue += `**📅 Date :** ${new Date(bet.timestamp).toLocaleDateString('fr-FR', {
        day: 'numeric',
        month: 'long',
        year: 'numeric'
      })}`;
    }

    embed.addFields({
      name: fieldName,
      value: fieldValue,
      inline: false
    });
  }

  // Statistiques globales
  const totalBetsCount = allWinningBets.length;
  const avgOdds = (allWinningBets.reduce((sum, b) => sum + b.odds, 0) / totalBetsCount).toFixed(2);
  const totalWinnings = allWinningBets.reduce((sum, b) => sum + b.winnings, 0);

  embed.addFields({
    name: '📊 Statistiques Globales',
    value: 
      `**Total de paris gagnés :** ${totalBetsCount}\n` +
      `**Cote moyenne :** ${avgOdds}x\n` +
      `**Total des gains :** ${totalWinnings}€`,
    inline: false
  });

  embed.setFooter({ text: '💡 Continuez à parier pour entrer dans le classement !' });

  message.reply({ embeds: [embed] });
}
  
if (command === '!aide' || command === '!help') {
  const helpEmbed = new EmbedBuilder()
    .setColor('#FFD700')
    .setTitle('⚡ PEACE & BET BOT ⚡')
    .setDescription(
      '**🎰 VIENS PARIER SUR TES MATCHS**\n' +
      '**💰 AMASSE DE L\'ARGENT**\n' +
      '**🏆 GRIMPE LE LADDER**\n\n' +
      '💵 Tu commences avec **100€** au départ !'
    )
    .addFields(
      // ========== COMMANDES PRINCIPALES ==========
      { 
        name: '━━━━━━━━━━━━━━━━━━━━━', 
        value: '**💎 COMMANDES PRINCIPALES**', 
        inline: false 
      },
      { 
        name: '🎲 Parier sur un match', 
        value: 
          '**Option 1 :** Clique sur l\'emoji en réaction au pari\n' +
          '**Option 2 :** `!pari [id] [option] [montant]`\n\n' +
          '📋 Liste des paris : `!paris`\n' +
          '📌 Exemple : `!pari 123456789 1 50`',
        inline: false
      },
      { 
        name: '🎰 Créer un combiné', 
        value: 
          '`!combi-add [id1] [opt1] [id2] [opt2] ... [montant]`\n' +
          '🔢 Alias : `!ca`\n\n' +
          '💡 Jusqu\'à **10 matchs** dans un combiné !\n' +
          '📈 Les cotes se **multiplient** !',
        inline: false
      },
      { 
        name: '📊 Consulter ton avancée', 
        value: 
          '• `!mes-paris` ou `!mp` → Tes paris en cours\n' +
          '• `!mes-combis` ou `!mc` → Tes combinés\n' +
          '• `!profil` → Ton profil détaillé\n' +
          '• `!classement` → Compare-toi aux autres !',
        inline: false
      },

      // ========== UTILITAIRES ==========
      { 
        name: '━━━━━━━━━━━━━━━━━━━━━', 
        value: '**🔧 UTILITAIRES**', 
        inline: false 
      },
      { 
        name: '💸 Aider un ami', 
        value: 
          '`!don @user [montant]`\n' +
          '📌 Exemple : `!don @Jean 50`\n' +
          '🔢 Alias : `!give`',
        inline: true
      },
      { 
        name: '❓ Aide', 
        value: 
          '`!help` ou `!aide`\n' +
          'Affiche ce message',
        inline: true
      },
      { 
        name: '\u200b', 
        value: '\u200b',
        inline: true
      },
      { 
        name: '🔥 Historique Winstreak', 
        value: 
          '`!streak-history` ou `!sh`\n' +
          'Tes 5 dernières winstreaks',
        inline: true
      },
      { 
        name: '🏆 Top 5 Winstreaks', 
        value: 
          '`!topstreak` ou `!streaks`\n' +
          'Les meilleures séries du serveur',
        inline: true
      },
      { 
        name: '💎 Top Cotes', 
        value: 
          '`!topcotes`\n' +
          'Les meilleures cotes gagnées',
        inline: true
      },

      // ========== MINI-JEUX ==========
      { 
        name: '━━━━━━━━━━━━━━━━━━━━━', 
        value: '**🎮 MINI-JEUX**', 
        inline: false 
      },
      { 
        name: '🎰 Roulette Quotidienne', 
        value: 
          '`!roulette` 🔢 Alias : `!spin`, `!roue`\n\n' +
          '⏰ **Une fois par jour**\n' +
          '🎁 Tourne la roue et gagne de l\'argent !',
        inline: false
      },
      { 
        name: '💥 SAFE OR RISK', 
        value: 
          '`!safe-or-risk [montant]` 🔢 Alias : `!sor`, `!risk`\n\n' +
          '**📋 RÈGLES :**\n' +
          '• Chaque tour = **multiplicateur plus élevé**\n' +
          '• À chaque tour : **ENCAISSER** 💰 ou **RISQUER** 🎲\n' +
          '• Plus tu montes, **moins tu as de chance** de réussir\n' +
          '• Si tu exploses : tu perds **TOUT** 💣\n' +
          '• **10 tours max** = JACKPOT **x30** ! 🏆\n\n' +
          '📌 Exemple : `!sor 100`',
        inline: false
      },

      // ========== ADMIN ==========
      { 
        name: '━━━━━━━━━━━━━━━━━━━━━', 
        value: `**⚙️ COMMANDES ADMIN** (Rôle : **${BETTING_CREATOR_ROLE}**)`, 
        inline: false 
      },
      { 
        name: '📝 Créer un pari', 
        value: 
          '`!creer-pari [question] | [opt1]:[cote1] | [opt2]:[cote2] | [heure]`\n' +
          '📌 Ex : `!creer-pari PSG vs OM ? | PSG:2 | OM:3 | 21h30`',
        inline: false
      },
      { 
        name: '⚡ Créer un boost', 
        value: 
          '`!boost [event] | [cote] | [heure]`\n' +
          '📌 Ex : `!boost Victoire PSG | 5.5 | 21h30`\n\n' +
          '💎 **Pari spécial** avec cote élevée !',
        inline: false
      },
      { 
        name: '✅ Valider un pari', 
        value: 
          '`!valider [id] [options gagnantes]`\n' +
          '📌 Ex : `!valider 123456789 1 3`\n\n' +
          '🔥 Pour un boost perdu : `!boostperdu [id]`',
        inline: false
      },
      { 
        name: '🔧 Autres commandes admin', 
        value: 
          '• `!lock [id]` → Clôturer manuellement\n' +
          '• `!modifier-solde @user [montant]` → Modifier un solde\n' +
          '• `!annuler-tout` → Annuler tous les paris actifs',
        inline: false
      }
    )
    .setFooter({ 
      text: '💡 Astuce : Dans un combiné, les cotes se multiplient ! | 🍀 Bonne chance !' 
    })
    .setTimestamp();

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
  
  const parts = interaction.customId.split('_');
const action = parts[0];

// Si c'est un combiné, parser différemment
let betId, params;
if (action === 'combi') {
  // Structure: combi_subaction_userId_timestamp
  const subaction = parts[1];
  const userId = parts[2];
  params = [subaction, userId];
  betId = null; // Pas de betId pour les combinés
} else {
  // Structure normale: action_betId_param1_param2...
  betId = parts[1];
  params = parts.slice(2);
}
  
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
    // IGNORER LES PARIEURS DE COMBINÉ
    if (betData.isCombi || userId.includes('_combi')) {
      continue;
    }
    
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
  
  // ⭐ VÉRIFIER LES COMBINÉS MÊME QUAND IL N'Y A PAS DE GAGNANTS
  const combiNotifications = await checkCombisForBet(betId, winningOptions);
  
  // ⭐ AFFICHER LES COMBINÉS AFFECTÉS
  if (combiNotifications && combiNotifications.length > 0) {
    let combiText = '\n\n🎰 **Combinés affectés :**\n';
    
    for (const notif of combiNotifications) {
      if (notif.type === 'won') {
        combiText += `\n🏆🎉 <@${notif.userId}> : COMBINÉ GAGNANT ! (${notif.totalBets} matchs)`;
        combiText += `\n   ├─ Mise : ${notif.stake}€`;
        combiText += `\n   ├─ Cote : ${notif.odds.toFixed(2)}x`;
        combiText += `\n   ├─ 💰 GAIN : **${notif.potentialWin}€**`;
        combiText += `\n   └─ Profit : **+${notif.profit}€**`;
        
      } else if (notif.type === 'lost') {
        combiText += `\n❌ <@${notif.userId}> : Combiné **PERDU** (${notif.totalBets} matchs, ${notif.stake}€ perdus)`;
        combiText += `\n   └─ Pari perdant : **${notif.question}** → ${notif.optionName}`;
        
      } else if (notif.type === 'progress') {
        combiText += `\n✅ <@${notif.userId}> : Combiné en progression (${notif.resolved}/${notif.total})`;
        combiText += `\n   ├─ **${notif.question}** → ${notif.optionName} ✅`;
        combiText += `\n   └─ Gain potentiel : **${notif.potentialWin}€** (${notif.odds.toFixed(2)}x)`;
      }
    }
    
    await interaction.followUp(combiText);
  }

// ⭐ CALCULER ET AFFICHER LES MISES PERDUES
let totalLost = 0;
let losersCount = 0;

for (const [userId, betData] of Object.entries(bettorsObj)) {
  if (betData.isCombi || userId.includes('_combi')) {
    continue;
  }
  totalLost += betData.amount;
  losersCount++;
}

if (losersCount > 0) {
  await interaction.followUp(`💸 **Mises perdues** : ${losersCount} parieur(s) ont perdu un total de **${totalLost}€**`);
}
  
  return;
}

// CAS 2 : Il y a des gagnants
let distributionText = '🏆 **Résultats du pari**\n\n';
distributionText += `Options gagnantes : ${winningOptions.map(i => bet.options[i].name).join(', ')}\n\n`;

let totalDistributed = 0;
let simpleWinners = [];
let simpleLosers = [];

// Traiter tous les parieurs
for (const [userId, betData] of Object.entries(bettorsObj)) {
  // IGNORER LES PARIEURS DE COMBINÉ
  if (betData.isCombi || userId.includes('_combi')) {
    console.log(`⭐️ ${userId} fait partie d'un combiné, ignoré`);
    continue;
  }
  
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

// ⭐ GESTION WINSTREAK POUR PARIS SIMPLES
const streakBonus = await handleWinstreak(user, bet.channelId, {
  question: bet.question,
  option: bet.options[betData.option].name,
  amount: betData.amount,
  winnings: winnings,
  type: 'simple'
});
    
    simpleWinners.push({
      userId,
      amount: betData.amount,
      odds,
      winnings,
      profit
    });
    
    user.history.push({
      betId: bet.messageId,
      question: bet.question,
      option: bet.options[betData.option].name,
      amount: betData.amount,
      winnings: winnings,
      result: 'won',
      timestamp: new Date()
    });

    // ⭐ VÉRIFICATION PALIER
await handleMilestone(user, bet.channelId);

    console.log(`✅ ${userId} a gagné ${winnings}€`);
  } else {
    // PERDANT
    user.stats.lostBets++;
    await breakWinstreak(user, bet.channelId);
    
    simpleLosers.push({
      userId,
      amount: betData.amount,
      option: bet.options[betData.option].name
    });
    
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

// ⭐ AFFICHER LES GAGNANTS DE PARIS SIMPLES
if (simpleWinners.length > 0) {
  distributionText += '**💰 Gagnants (Paris simples) :**\n';
  for (const w of simpleWinners) {
    distributionText += `• <@${w.userId}> : Misé ${w.amount}€ (cote ${w.odds}x) → Gagné **${w.winnings}€** (profit: +${w.profit}€)\n`;
  }
  distributionText += '\n';
}

// ⭐ AFFICHER LES PERDANTS DE PARIS SIMPLES
if (simpleLosers.length > 0) {
  distributionText += '**❌ Perdants (Paris simples) :**\n';
  for (const l of simpleLosers) {
    distributionText += `• <@${l.userId}> : Perdu ${l.amount}€ sur ${l.option}\n`;
  }
  distributionText += '\n';
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
    { name: '👥 Gagnants', value: `${simpleWinners.length}`, inline: true }
  );

await interaction.message.edit({ embeds: [updatedEmbed], components: [] });

// ⭐ VÉRIFIER LES COMBINÉS ET OBTENIR LES NOTIFICATIONS
const combiNotifications = await checkCombisForBet(betId, winningOptions);

// ⭐ AJOUTER LES NOTIFICATIONS DE COMBINÉS AU MESSAGE
if (combiNotifications && combiNotifications.length > 0) {
  distributionText += '🎰 **Combinés affectés :**\n';
  
  for (const notif of combiNotifications) {
    if (notif.type === 'lost') {
      distributionText += `\n❌ <@${notif.userId}> : Combiné **PERDU** (${notif.totalBets} matchs, ${notif.stake}€ perdus)`;
      distributionText += `\n   └─ Pari perdant : **${notif.question}** → ${notif.optionName}`;
    } else if (notif.type === 'progress') {
      distributionText += `\n✅ <@${notif.userId}> : Combiné en progression (${notif.resolved}/${notif.total})`;
      distributionText += `\n   └─ **${notif.question}** → ${notif.optionName} ✅`;
      distributionText += `\n   └─ Gain potentiel : **${notif.potentialWin}€** (${notif.odds.toFixed(2)}x)`;
    }
  }
}

await interaction.reply(distributionText);

console.log(`✅ Validation terminée - ${simpleWinners.length} gagnants, ${totalDistributed}€ distribués`);
}

    if (action === 'combi') {
  const subaction = params[0];
  const userId = params[1];

  console.log('🔍 DEBUG COMBI');
  console.log('subaction:', subaction);
  console.log('userId (du bouton):', userId);
  console.log('interaction.user.id:', interaction.user.id);
  console.log('Match?', interaction.user.id === userId);

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
    
// ⭐ ENREGISTRER L'UTILISATEUR COMME PARIEUR SUR CHAQUE PARI
    for (const bet of basket.bets) {
      try {
        await Bet.findOneAndUpdate(
          { 
            messageId: bet.messageId,
            [`bettors.${userId}`]: { $exists: false }
          },
          { 
            $set: { 
             [`bettors.${userId}_combi_${combiId}`]: { // ⭐ Clé unique
                option: bet.optionIndex,
                amount: bet.amount,
                username: interaction.user.tag,
                odds: bet.odds,
                isCombi: true,
                combiId: combiId,
                userIdOriginal: userId // ⭐ Garder l'ID original
              }
            },
            $inc: { totalPool: bet.amount }
          }
        );
        console.log(`✅ Ajouté ${interaction.user.tag} sur pari ${bet.messageId}`);
      } catch (error) {
        console.error(`❌ Erreur:`, error);
      }
    }

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
