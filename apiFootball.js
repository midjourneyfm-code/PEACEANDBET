// ==================== MODULE API-FOOTBALL ====================
// Ajouter ce fichier : apiFootball.js

const axios = require('axios');
const config = require('./config.json');

const API_KEY = config.apiFootballKey;
const BASE_URL = 'https://v3.football.api-sports.io';

// Cache pour éviter de gaspiller les requêtes
const cache = new Map();
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24h

function getCacheKey(endpoint, params) {
  return `${endpoint}_${JSON.stringify(params)}`;
}

function getFromCache(key) {
  const cached = cache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
    console.log('📦 Cache hit:', key);
    return cached.data;
  }
  return null;
}

function saveToCache(key, data) {
  cache.set(key, { data, timestamp: Date.now() });
}

// ==================== FONCTIONS API ====================

/**
 * Rechercher un match par équipes et ligue
 */
async function searchFixture(homeTeam, awayTeam, league, date = null) {
  try {
    const today = date || new Date();
    const dateStr = today.toISOString().split('T')[0];
    
    const response = await axios.get(`${BASE_URL}/fixtures`, {
      headers: { 'x-apisports-key': API_KEY },
      params: {
        date: dateStr,
        league: getLeagueId(league),
        season: today.getFullYear()
      }
    });

    if (!response.data.results) return null;

    // Chercher le match correspondant
    const fixture = response.data.response.find(f => {
      const home = f.teams.home.name.toLowerCase();
      const away = f.teams.away.name.toLowerCase();
      return (
        home.includes(homeTeam.toLowerCase()) && 
        away.includes(awayTeam.toLowerCase())
      );
    });

    return fixture;
  } catch (error) {
    console.error('❌ Erreur recherche match:', error.message);
    return null;
  }
}

/**
 * Obtenir les statistiques H2H entre deux équipes
 */
async function getH2H(team1Id, team2Id) {
  const cacheKey = getCacheKey('h2h', { team1Id, team2Id });
  const cached = getFromCache(cacheKey);
  if (cached) return cached;

  try {
    const response = await axios.get(`${BASE_URL}/fixtures/headtohead`, {
      headers: { 'x-apisports-key': API_KEY },
      params: {
        h2h: `${team1Id}-${team2Id}`,
        last: 5
      }
    });

    const data = response.data.response;
    saveToCache(cacheKey, data);
    return data;
  } catch (error) {
    console.error('❌ Erreur H2H:', error.message);
    return [];
  }
}

/**
 * Obtenir la forme récente d'une équipe
 */
async function getTeamForm(teamId, last = 5) {
  const cacheKey = getCacheKey('form', { teamId, last });
  const cached = getFromCache(cacheKey);
  if (cached) return cached;

  try {
    const response = await axios.get(`${BASE_URL}/fixtures`, {
      headers: { 'x-apisports-key': API_KEY },
      params: {
        team: teamId,
        last: last,
        status: 'FT'
      }
    });

    const data = response.data.response;
    saveToCache(cacheKey, data);
    return data;
  } catch (error) {
    console.error('❌ Erreur forme équipe:', error.message);
    return [];
  }
}

/**
 * Obtenir le classement d'une équipe dans sa ligue
 */
async function getTeamStanding(teamId, leagueId, season) {
  const cacheKey = getCacheKey('standing', { teamId, leagueId, season });
  const cached = getFromCache(cacheKey);
  if (cached) return cached;

  try {
    const response = await axios.get(`${BASE_URL}/standings`, {
      headers: { 'x-apisports-key': API_KEY },
      params: {
        league: leagueId,
        season: season,
        team: teamId
      }
    });

    const standings = response.data.response[0]?.league.standings[0];
    const teamStanding = standings?.find(s => s.team.id === teamId);
    
    saveToCache(cacheKey, teamStanding);
    return teamStanding;
  } catch (error) {
    console.error('❌ Erreur classement:', error.message);
    return null;
  }
}

/**
 * Obtenir les statistiques d'un match en cours
 */
async function getLiveMatchStats(fixtureId) {
  try {
    const response = await axios.get(`${BASE_URL}/fixtures`, {
      headers: { 'x-apisports-key': API_KEY },
      params: { id: fixtureId }
    });

    return response.data.response[0];
  } catch (error) {
    console.error('❌ Erreur stats live:', error.message);
    return null;
  }
}

/**
 * Obtenir les événements d'un match (buts, cartons, etc.)
 */
async function getMatchEvents(fixtureId) {
  try {
    const response = await axios.get(`${BASE_URL}/fixtures/events`, {
      headers: { 'x-apisports-key': API_KEY },
      params: { fixture: fixtureId }
    });

    return response.data.response;
  } catch (error) {
    console.error('❌ Erreur événements match:', error.message);
    return [];
  }
}

/**
 * Statistiques domicile/extérieur d'une équipe
 */
async function getHomeAwayStats(teamId, leagueId, season) {
  const cacheKey = getCacheKey('home_away', { teamId, leagueId, season });
  const cached = getFromCache(cacheKey);
  if (cached) return cached;

  try {
    const response = await axios.get(`${BASE_URL}/teams/statistics`, {
      headers: { 'x-apisports-key': API_KEY },
      params: {
        team: teamId,
        league: leagueId,
        season: season
      }
    });

    const data = response.data.response;
    saveToCache(cacheKey, data);
    return data;
  } catch (error) {
    console.error('❌ Erreur stats domicile/extérieur:', error.message);
    return null;
  }
}

// ==================== UTILITAIRES ====================

/**
 * Obtenir l'ID de la ligue depuis le nom
 */
function getLeagueId(leagueName) {
  const leagues = {
    'ligue 1': 61,
    'premier league': 39,
    'la liga': 140,
    'serie a': 135,
    'bundesliga': 78,
    'ligue 2': 62,
    'championship': 40,
    'champions league': 2,
    'europa league': 3
  };

  const key = leagueName.toLowerCase().trim();
  return leagues[key] || 61; // Par défaut Ligue 1
}

/**
 * Formater les résultats de forme (W/D/L)
 */
function formatForm(fixtures, teamId) {
  return fixtures.map(f => {
    const homeId = f.teams.home.id;
    const awayId = f.teams.away.id;
    const homeGoals = f.goals.home;
    const awayGoals = f.goals.away;

    if (homeGoals === awayGoals) return '🟨'; // Draw
    
    if (teamId === homeId) {
      return homeGoals > awayGoals ? '✅' : '❌';
    } else {
      return awayGoals > homeGoals ? '✅' : '❌';
    }
  }).join(' ');
}

/**
 * Calculer les tendances d'un match
 */
function analyzeTrends(h2h, homeStats, awayStats) {
  const trends = [];

  // Analyser les buts marqués
  const totalGoals = h2h.reduce((sum, f) => sum + f.goals.home + f.goals.away, 0);
  const avgGoals = totalGoals / h2h.length;
  
  if (avgGoals > 2.5) {
    trends.push('• Les derniers H2H ont été riches en buts');
  }

  // Analyser la forme à domicile/extérieur
  if (homeStats?.fixtures?.wins?.home > homeStats?.fixtures?.draws?.home + homeStats?.fixtures?.loses?.home) {
    trends.push(`• L'équipe domicile est forte à la maison`);
  }

  if (awayStats?.fixtures?.wins?.away > awayStats?.fixtures?.draws?.away + awayStats?.fixtures?.loses?.away) {
    trends.push(`• L'équipe extérieur performe bien en déplacement`);
  }

  return trends.length > 0 ? trends : ['• Pas de tendance marquante'];
}

// ==================== EXPORTS ====================

module.exports = {
  searchFixture,
  getH2H,
  getTeamForm,
  getTeamStanding,
  getLiveMatchStats,
  getMatchEvents,
  getHomeAwayStats,
  formatForm,
  analyzeTrends,
  getLeagueId
};
