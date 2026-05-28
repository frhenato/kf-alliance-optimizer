/**
 * optimizer.js - Frontend Alliance Optimizer
 * 
 * All processing logic runs in the browser.
 * The backend only provides a CORS proxy to the DoK API.
 */

import { calculateSAS, computeTokensPerGame } from './synergy-engine.js'

// ─── Configuration ────────────────────────────────────────────────────────────

const TOP_HOUSES_PER_SLOT = 20
const MAX_ALLIANCES = 500

// ─── Alliance Rules ───────────────────────────────────────────────────────────

const INVALID_ALLIANCE_EXPANSIONS = new Set(['MARTIAN_CIVIL_WAR'])

const EXPANSIONS_WITH_TOKENS = new Set([
  'WINDS_OF_EXCHANGE',
  'UNCHAINED_2022',
  'VAULT_MASTERS_2023',
  'MENAGERIE_2024',
  'TOKENS_OF_CHANGE',
  'MARTIAN_CIVIL_WAR',
])

const NON_SELECTABLE_HOUSES = new Set(['Prophecy', 'ArchonPower'])

const RESTRICTED_CARDS = {
  'Befuddle':            100,
  'Chronus':             100,
  'Ghostform':           100,
  'Hallafest':             1,
  'Heart of the Forest': 100,
  'Infurnace':           100,
  'Jervi':               100,
  'Key Abduction':         1,
  'Legionary Trainer':   100,
  'Stealth Mode':        100,
  'United Action':       100,
  'Winds of Death':      100,
}

// ─── Expansion labels ─────────────────────────────────────────────────────────

export const EXPANSION_LABELS = {
  CALL_OF_THE_ARCHONS:  'Call of the Archons',
  AGE_OF_ASCENSION:     'Age of Ascension',
  WORLDS_COLLIDE:       'Worlds Collide',
  ANOMALY_EXPANSION:    'Anomaly Expansion',
  MASS_MUTATION:        'Mass Mutation',
  DARK_TIDINGS:         'Dark Tidings',
  WINDS_OF_EXCHANGE:    'Winds of Exchange',
  UNCHAINED_2022:       'Unchained 2022',
  VAULT_MASTERS_2023:   'Vault Masters 2023',
  GRIM_REMINDERS:       'Grim Reminders',
  MENAGERIE_2024:       'Menagerie 2024',
  VAULT_MASTERS_2024:   'Vault Masters 2024',
  AEMBER_SKIES:         'Aember Skies',
  TOKENS_OF_CHANGE:     'Tokens of Change',
  MORE_MUTATION:        'More Mutation',
  MARTIAN_CIVIL_WAR:    'Martian Civil War',
  DRACONIAN_MEASURES:   'Draconian Measures',
  PROPHETIC_VISIONS:    'Prophetic Visions',
  CRUCIBLE_CLASH:       'Crucible Clash',
  VAULT_MASTERS_2025:   'Vault Masters 2025',
  VAULT_MASTERS_2026:   'Vault Masters 2026',
}

// ─── API Helper ───────────────────────────────────────────────────────────────

async function apiGet(path, apiKey, params = {}) {
  const queryString = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')
  
  const url = `/api/proxy?path=${encodeURIComponent(path)}${queryString ? '&' + queryString : ''}`

  let response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { 'Api-Key': apiKey },
    })
  } catch (err) {
    throw new Error('Nao foi possivel acessar /api/proxy. Rode o projeto com "npm run dev" ou publique com Functions (Vercel/Netlify/Cloudflare).')
  }
  
  if (!response.ok) {
    const text = await response.text()
    if (response.status === 404 && /api|not found|cannot get/i.test(text)) {
      throw new Error('API proxy nao encontrada em /api/proxy. Rode com "npm run dev" ou configure deploy serverless para a pasta /api.')
    }
    throw new Error(`API error: ${response.status} - ${text}`)
  }
  
  return response.json()
}

// ─── Data Fetching ────────────────────────────────────────────────────────────

export async function fetchAllDecks(apiKey, onProgress) {
  const decks = []
  let page = 0, hasMore = true
  
  while (hasMore) {
    const response = await apiGet('/v1/my-decks', apiKey, { page })
    
    if (!Array.isArray(response) || response.length === 0) {
      hasMore = false
    } else {
      for (const info of response) {
        if (info && info.deck) {
          decks.push(info.deck)
        }
      }
      if (onProgress) onProgress(`Decks carregados: ${decks.length}`)
      if (response.length < 100) hasMore = false
      else { page++; await sleep(300) }
    }
  }
  
  return { decks, sasVersion: 53 }
}

export async function fetchAllCards(apiKey, onProgress) {
  if (onProgress) onProgress('Carregando banco de cartas do DoK...')
  
  const cards = await apiGet('/v1/cards', apiKey)
  const cardList = Array.isArray(cards) ? cards : []
  
  const cardMap = new Map()
  for (const card of cardList) {
    if (!cardMap.has(card.cardTitle)) cardMap.set(card.cardTitle, card)
  }
  
  if (onProgress) onProgress(`${cardMap.size} cartas únicas carregadas.`)
  return cardMap
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

// ─── House helpers ────────────────────────────────────────────────────────────

function realHouses(deck) {
  if (!deck.housesAndCards) return []
  return deck.housesAndCards
    .map(h => h.house)
    .filter(h => h && !NON_SELECTABLE_HOUSES.has(h))
}

function houseCardTitles(deck, house) {
  const entry = deck.housesAndCards?.find(h => h.house === house)
  return entry ? entry.cards.map(c => c.cardTitle) : []
}

function houseScore(deck, house) {
  if (!deck.synergyDetails) return 0
  return deck.synergyDetails
    .filter(c => c.house === house)
    .reduce((sum, c) => sum + (c.aercScore || 0) * (c.copies || 1), 0)
}

function isValidAlliance(expansion, allCardTitles) {
  if (INVALID_ALLIANCE_EXPANSIONS.has(expansion)) return false
  const counts = {}
  for (const t of allCardTitles) {
    if (Object.prototype.hasOwnProperty.call(RESTRICTED_CARDS, t))
      counts[t] = (counts[t] || 0) + 1
  }
  const types = Object.keys(counts)
  if (types.length > 1) return false
  for (const t of types) { if (counts[t] > RESTRICTED_CARDS[t]) return false }
  return true
}

// ─── Card builder ─────────────────────────────────────────────────────────────

const EMPTY_CARD_INFO = {
  expectedAmber: 0, expectedAmberMax: 0, amberControl: 0, amberControlMax: 0,
  artifactControl: 0, artifactControlMax: 0, creatureControl: 0, creatureControlMax: 0,
  efficiency: 0, efficiencyMax: 0, recursion: 0, recursionMax: 0,
  effectivePower: 0, effectivePowerMax: 0, disruption: 0, disruptionMax: 0,
  creatureProtection: 0, creatureProtectionMax: 0, other: 0, otherMax: 0,
  baseSynPercent: null, traits: [], synergies: [], extraCardTypes: [],
}

function buildAllianceCards(deck, house, cardMap) {
  const entry = deck.housesAndCards?.find(h => h.house === house)
  if (!entry) return []
  return entry.cards.map(sc => {
    const fc = cardMap.get(sc.cardTitle)
    return {
      cardTitle:    sc.cardTitle,
      cardType:     fc ? (fc.cardType || 'Action') : 'Action',
      amber:        fc ? (fc.amber  || 0) : 0,
      power:        fc ? (fc.power  || 0) : 0,
      armor:        fc ? (fc.armor  || 0) : 0,
      traits:       fc ? (fc.traits || []) : [],
      big:          fc ? (fc.big    || false) : false,
      house,
      bonusAember:  sc.bonusAember  || 0,
      bonusCapture: sc.bonusCapture || 0,
      bonusDamage:  sc.bonusDamage  || 0,
      bonusDraw:    sc.bonusDraw    || 0,
      bonusDiscard: sc.bonusDiscard || 0,
      bonusPower:   sc.bonusPower   || 0,
      bonusHouses:  Array.isArray(sc.bonusHouses) ? sc.bonusHouses : [],
      extraCardInfo: fc ? (fc.extraCardInfo || EMPTY_CARD_INFO) : EMPTY_CARD_INFO,
    }
  })
}

function buildTokenCard(tokenName, tokenHouse, cardMap) {
  const fc = cardMap?.get(tokenName)
  if (!fc) return null
  return {
    cardTitle:    tokenName,
    cardType:     'TokenCreature',
    amber:        fc.amber  || 0,
    power:        fc.power  || 0,
    armor:        fc.armor  || 0,
    traits:       fc.traits || [],
    big:          false,
    house:        tokenHouse,
    bonusAember:  0,
    bonusCapture: 0,
    bonusDamage:  0,
    bonusDraw:    0,
    bonusDiscard: 0,
    bonusPower:   0,
    bonusHouses:  [],
    extraCardInfo: fc.extraCardInfo || EMPTY_CARD_INFO,
  }
}

// ─── Top-N House Selection ────────────────────────────────────────────────────

export function getTopHousesPerExpansion(decks, topN = TOP_HOUSES_PER_SLOT) {
  const result = {}
  for (const deck of decks) {
    const exp = deck.expansion
    if (!exp || INVALID_ALLIANCE_EXPANSIONS.has(exp)) continue
    if (!result[exp]) result[exp] = {}
    for (const house of realHouses(deck)) {
      if (!result[exp][house]) result[exp][house] = []
      result[exp][house].push({ deck, house, score: houseScore(deck, house) })
    }
  }
  for (const exp of Object.values(result)) {
    for (const house of Object.keys(exp)) {
      exp[house].sort((a, b) => b.score - a.score)
      exp[house] = exp[house].slice(0, topN)
    }
  }
  return result
}

export function countCombinations(topHousesForExpansion) {
  const names = Object.keys(topHousesForExpansion)
  let total = 0
  for (let i = 0; i < names.length - 2; i++)
    for (let j = i + 1; j < names.length - 1; j++)
      for (let k = j + 1; k < names.length; k++)
        total += topHousesForExpansion[names[i]].length *
                 topHousesForExpansion[names[j]].length *
                 topHousesForExpansion[names[k]].length
  return total
}

// ─── Alliance Builder ─────────────────────────────────────────────────────────

export async function buildAlliancesForExpansion(topHousesForExpansion, expansion, cardMap, onProgress) {
  const names = Object.keys(topHousesForExpansion)
  const alliances = []
  let done = 0
  const total = countCombinations(topHousesForExpansion)
  
  // Optimization: after MAX_ALLIANCES, only keep better results
  let minSas = -Infinity
  let minIndex = -1
  
  // Yield to event loop every N iterations
  const YIELD_INTERVAL = 50
  let iterCount = 0
  
  function addAlliance(alliance) {
    if (alliances.length < MAX_ALLIANCES) {
      alliances.push(alliance)
      if (alliance.score < minSas || minIndex === -1) {
        minSas = alliance.score
        minIndex = alliances.length - 1
      }
    } else if (alliance.score > minSas) {
      alliances[minIndex] = alliance
      minSas = Infinity
      for (let idx = 0; idx < alliances.length; idx++) {
        if (alliances[idx].score < minSas) {
          minSas = alliances[idx].score
          minIndex = idx
        }
      }
    }
  }

  for (let i = 0; i < names.length - 2; i++) {
    const h1 = names[i], slots1 = topHousesForExpansion[h1]
    for (let j = i + 1; j < names.length - 1; j++) {
      const h2 = names[j], slots2 = topHousesForExpansion[h2]
      for (let k = j + 1; k < names.length; k++) {
        const h3 = names[k], slots3 = topHousesForExpansion[h3]
        for (const s1 of slots1) {
          for (const s2 of slots2) {
            for (const s3 of slots3) {
              done++
              iterCount++
              if (onProgress) onProgress(done, total)
              
              // Yield to event loop periodically
              if (iterCount >= YIELD_INTERVAL) {
                iterCount = 0
                await new Promise(r => setTimeout(r, 0))
              }

              const allCardTitles = [
                ...houseCardTitles(s1.deck, h1),
                ...houseCardTitles(s2.deck, h2),
                ...houseCardTitles(s3.deck, h3),
              ]
              if (!isValidAlliance(expansion, allCardTitles)) continue

              // Token selection (only for token expansions)
              let tokens = null
              if (EXPANSIONS_WITH_TOKENS.has(expansion)) {
                const allianceHouses = new Set([h1, h2, h3])
                const seen = new Set()
                const validTokens = []
                for (const s of [s1, s2, s3]) {
                  const ti = s.deck.tokenInfo
                  if (ti && !seen.has(ti.name) && allianceHouses.has(ti.house)) {
                    seen.add(ti.name)
                    validTokens.push({ name: ti.name, house: ti.house })
                  }
                }
                if (validTokens.length === 0) continue

                let baseCards = [
                  ...buildAllianceCards(s1.deck, h1, cardMap),
                  ...buildAllianceCards(s2.deck, h2, cardMap),
                  ...buildAllianceCards(s3.deck, h3, cardMap),
                ]

                tokens = validTokens.map(t => {
                  let result = { sas: Math.round(s1.score + s2.score + s3.score) }
                  result.rawAerc = result.sas
                  result.synergy = 0
                  result.antisynergy = 0
                  result.componentSas = null
                  result.efficiencyBonus = 0
                  try {
                    const tokenCard = buildTokenCard(t.name, t.house, cardMap)
                    const r = calculateSAS(baseCards, expansion, tokenCard || undefined)
                    result = { ...r, componentSas: r.perHouse || null }
                  } catch (_) {}
                  return { name: t.name, house: t.house, ...result }
                })

                tokens.sort((a, b) => b.sas - a.sas)
                const best = tokens[0]
                
                addAlliance({
                  expansion, score: best.sas, rawAerc: best.rawAerc,
                  synergy: best.synergy, antisynergy: best.antisynergy,
                  efficiencyBonus: best.efficiencyBonus || 0,
                  amberControl: best.amberControl || 0,
                  expectedAmber: best.expectedAmber || 0,
                  artifactControl: best.artifactControl || 0,
                  creatureControl: best.creatureControl || 0,
                  efficiency: best.efficiency || 0,
                  recursion: best.recursion || 0,
                  disruption: best.disruption || 0,
                  effectivePower: best.effectivePower || 0,
                  creatureProtection: best.creatureProtection || 0,
                  other: best.other || 0,
                  creatureCount: best.creatureCount || 0,
                  actionCount: best.actionCount || 0,
                  artifactCount: best.artifactCount || 0,
                  upgradeCount: best.upgradeCount || 0,
                  tokenCount: best.tokenCount || 0,
                  bonusAmber: best.bonusAmber || 0,
                  totalPower: best.totalPower || 0,
                  totalArmor: best.totalArmor || 0,
                  manipulatesTide: best.manipulatesTide || 0,
                  usesTide: best.usesTide || 0,
                  archivesTargeted: best.archivesTargeted || 0,
                  archivesRandom: best.archivesRandom || 0,
                  keyCheatCount: best.keyCheatCount || 0,
                  scalingAmberControl: best.scalingAmberControl || 0,
                  boardWipeCount: best.boardWipeCount || 0,
                  tokens,
                  components: [
                    { house: h1, deckName: s1.deck.name, deckId: s1.deck.keyforgeId, deckSas: s1.deck.sasRating, houseAerc: best.componentSas?.[h1] || Math.round(s1.score) },
                    { house: h2, deckName: s2.deck.name, deckId: s2.deck.keyforgeId, deckSas: s2.deck.sasRating, houseAerc: best.componentSas?.[h2] || Math.round(s2.score) },
                    { house: h3, deckName: s3.deck.name, deckId: s3.deck.keyforgeId, deckSas: s3.deck.sasRating, houseAerc: best.componentSas?.[h3] || Math.round(s3.score) },
                  ],
                })
                continue
              }

              // Non-token expansion path
              let result = { sas: Math.round(s1.score + s2.score + s3.score) }
              result.rawAerc = result.sas
              result.synergy = 0
              result.antisynergy = 0
              let componentSas = null

              try {
                const cards = [
                  ...buildAllianceCards(s1.deck, h1, cardMap),
                  ...buildAllianceCards(s2.deck, h2, cardMap),
                  ...buildAllianceCards(s3.deck, h3, cardMap),
                ]
                const r = calculateSAS(cards, expansion)
                result = r
                componentSas = r.perHouse || null
              } catch (_) {}

              addAlliance({
                expansion, score: result.sas, rawAerc: result.rawAerc,
                synergy: result.synergy, antisynergy: result.antisynergy,
                efficiencyBonus: result.efficiencyBonus || 0,
                amberControl: result.amberControl || 0,
                expectedAmber: result.expectedAmber || 0,
                artifactControl: result.artifactControl || 0,
                creatureControl: result.creatureControl || 0,
                efficiency: result.efficiency || 0,
                recursion: result.recursion || 0,
                disruption: result.disruption || 0,
                effectivePower: result.effectivePower || 0,
                creatureProtection: result.creatureProtection || 0,
                other: result.other || 0,
                creatureCount: result.creatureCount || 0,
                actionCount: result.actionCount || 0,
                artifactCount: result.artifactCount || 0,
                upgradeCount: result.upgradeCount || 0,
                tokenCount: result.tokenCount || 0,
                bonusAmber: result.bonusAmber || 0,
                totalPower: result.totalPower || 0,
                totalArmor: result.totalArmor || 0,
                manipulatesTide: result.manipulatesTide || 0,
                usesTide: result.usesTide || 0,
                archivesTargeted: result.archivesTargeted || 0,
                archivesRandom: result.archivesRandom || 0,
                keyCheatCount: result.keyCheatCount || 0,
                scalingAmberControl: result.scalingAmberControl || 0,
                boardWipeCount: result.boardWipeCount || 0,
                tokens: null,
                components: [
                  { house: h1, deckName: s1.deck.name, deckId: s1.deck.keyforgeId, deckSas: s1.deck.sasRating, houseAerc: componentSas?.[h1] || Math.round(s1.score) },
                  { house: h2, deckName: s2.deck.name, deckId: s2.deck.keyforgeId, deckSas: s2.deck.sasRating, houseAerc: componentSas?.[h2] || Math.round(s2.score) },
                  { house: h3, deckName: s3.deck.name, deckId: s3.deck.keyforgeId, deckSas: s3.deck.sasRating, houseAerc: componentSas?.[h3] || Math.round(s3.score) },
                ],
              })
            }
          }
        }
      }
    }
  }

  // Sort by SAS descending
  alliances.sort((a, b) => b.score - a.score)
  return alliances
}

// ─── Main optimizer function ──────────────────────────────────────────────────

export async function runOptimizer(apiKey, options = {}, callbacks = {}) {
  const {
    topN = TOP_HOUSES_PER_SLOT,
    houseFilter = null,
    expansionFilter = null,
  } = options
  
  const {
    onStatus = () => {},
    onProgress = () => {},
    onResult = () => {},
    onComplete = () => {},
    onError = () => {},
  } = callbacks
  
  try {
    const tStart = Date.now()
    
    // Step 1: fetch decks
    onStatus('Buscando seus decks...', 'fetching')
    const { decks: allDecks, sasVersion } = await fetchAllDecks(apiKey, msg => onStatus(msg, 'fetching'))
    onStatus(`${allDecks.length} decks carregados (SAS v${sasVersion || '?'}).`, 'fetching')
    
    // Step 2: fetch cards
    onStatus('Carregando banco de cartas...', 'fetching')
    const cardMap = await fetchAllCards(apiKey, msg => onStatus(msg, 'fetching'))
    
    // Step 3: filter + compute top houses
    onStatus('Filtrando decks elegíveis...', 'preparing')
    const usable = allDecks.filter(d =>
      d.expansion && Array.isArray(d.housesAndCards) && d.housesAndCards.length > 0 &&
      Array.isArray(d.synergyDetails) && d.synergyDetails.length > 0 &&
      !INVALID_ALLIANCE_EXPANSIONS.has(d.expansion)
    )
    onStatus(`${usable.length} decks elegíveis para alliance.`, 'preparing')
    
    onStatus(`Organizando top ${topN} casas por expansão...`, 'preparing')
    const topHouses = getTopHousesPerExpansion(usable, topN)
    
    // Filter expansion list if expansionFilter is specified
    let expansionList = Object.keys(topHouses)
    if (expansionFilter && expansionFilter.length > 0) {
      const expSet = new Set(expansionFilter)
      expansionList = expansionList.filter(exp => expSet.has(exp))
    }
    
    // Apply house filter
    if (houseFilter && houseFilter.length > 0) {
      const filterSet = new Set(houseFilter)
      for (const exp of expansionList) {
        const housesForExp = {}
        for (const h of Object.keys(topHouses[exp])) {
          if (filterSet.has(h)) {
            housesForExp[h] = topHouses[exp][h]
          }
        }
        topHouses[exp] = housesForExp
      }
    }
    
    // Calculate totals
    onStatus('Calculando total de combinações...', 'preparing')
    const expansionTotals = {}
    let grandTotal = 0
    for (const exp of expansionList) {
      const cnt = countCombinations(topHouses[exp])
      expansionTotals[exp] = cnt
      grandTotal += cnt
    }
    
    onStatus(`Total: ${grandTotal.toLocaleString('pt-BR')} combinações a analisar.`, 'building')
    
    let grandDone = 0
    
    // Step 4: build alliances per expansion
    for (const expansion of expansionList) {
      const houses = topHouses[expansion]
      const expTotal = expansionTotals[expansion]
      const label = EXPANSION_LABELS[expansion] || expansion
      
      if (expTotal === 0) continue
      
      onStatus(`Processando ${label}...`, 'building')
      onProgress({ expansion, label, done: 0, total: expTotal, pct: 0, grandDone, grandTotal })
      
      const alliances = await buildAlliancesForExpansion(
        houses, expansion, cardMap,
        (done, total) => {
          grandDone++
          const pct = Math.floor(done / total * 100)
          if (pct % 5 === 0 || done === total) {
            onProgress({
              expansion, label, done, total, pct,
              grandDone, grandTotal, grandPct: Math.floor(grandDone / grandTotal * 100)
            })
          }
        }
      )
      
      onStatus(`${label} concluído (${alliances.length} alianças válidas).`, 'building')
      onResult({ expansion, label, alliances })
    }
    
    const tTotal = ((Date.now() - tStart) / 1000).toFixed(1)
    onStatus(`Tempo total: ${tTotal}s.`, 'complete')
    onComplete()
    
  } catch (err) {
    onError(err.message)
  }
}
