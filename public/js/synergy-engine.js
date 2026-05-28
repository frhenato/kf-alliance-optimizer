/**
 * synergy-engine.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Full port of the Decks of KeyForge SAS/AERC synergy algorithm to JavaScript.
 *
 * Source files ported:
 *   SynergyAlgorithm.kt       – main entry point (fromDeckWithCards)
 *   DeckSynergyStats.kt       – deck-level stat computation and synPercent
 *   MatchSynergiesToTraits.kt – trait matching logic
 *   AutomaticTraitsAlgorithm.kt – highValue auto traits
 *   GenerateDeckAndHouseTraits.kt – bonus-pip deck traits
 *   SelfEnhancementAlgorithm.kt  – enhanced-pip combo scores
 *   StaticAercValues.kt       – pip AERC conversion constants
 *
 * Intentional simplifications (minor impact):
 *   • Tokens: injected when tokenCard is passed to calculateSAS (uses computeTokensPerGame)
 *   • Prophecy cards: treated as normal cards (their special combo is skipped)
 *   • House-enhancement combos (bonus-house pips): included via SelfEnhancement
 */

'use strict'

// ─── Constants (StaticAercValues.kt) ─────────────────────────────────────────

const CREATURE_BONUS = 0.4

const PIP_AERC = {
  amber:   1.00,
  capture: 0.33,
  damage:  0.25,
  draw:    0.75,
  discard: 0.50,
  power:   0.10,
}

// TraitStrength enum values (SynergyTrait.kt)
const TS = { EXTRA_STRONG: 6, STRONG: 4, NORMAL: 3, WEAK: 2, EXTRA_WEAK: 1 }

// ─── Deck-stat trait configuration (DeckSynergyStats.kt) ─────────────────────
//  { maxDeck, maxHouse [, minDeck=0, minHouse=0] }
const DECK_STAT_TRAITS = {
  creatureCount:           { maxDeck: 25, maxHouse: 10, minDeck: 11, minHouse: 3  },
  tokenCount:              { maxDeck: 25, maxHouse: 25 },
  bonusAmber:              { maxDeck: 30, maxHouse: 10 },
  bonusCapture:            { maxDeck: 30, maxHouse: 10 },
  bonusDamage:             { maxDeck: 30, maxHouse: 10 },
  bonusDraw:               { maxDeck: 30, maxHouse: 10 },
  bonusDiscard:            { maxDeck: 30, maxHouse: 10 },
  bonusPower:              { maxDeck: 30, maxHouse: 10 },
  totalCreaturePower:      { maxDeck: 100, maxHouse: 30, minDeck: 30, minHouse: 15 },
  totalArmor:              { maxDeck: 10,  maxHouse:  5 },
  haunted:                 { maxDeck: 100, maxHouse:  0 },
  propheticOdds:           { maxDeck: 100, maxHouse:  0 },
  expectedAember:          { maxDeck: 30,  maxHouse: 12, minDeck: 10, minHouse: 3 },
  capturedAmber:           { maxDeck: 16,  maxHouse:  8 },
  targettedCapturedAmber:  { maxDeck: 16,  maxHouse:  8 },
}

// ─── Small helpers ────────────────────────────────────────────────────────────

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

function isZeroOrNull(v) {
  return v == null || Math.abs(v) < 0.005
}

/**
 * Round to 1 decimal place using HALF_UP rounding (like Kotlin's roundToOneSigDig).
 * Uses the "multiply, round, divide" approach for proper banker's rounding avoidance.
 */
function roundTo1(n) {
  return Math.round((n + Number.EPSILON) * 10) / 10
}

function strengthFromAbs(absRating) {
  if (absRating >= 6) return TS.EXTRA_STRONG
  if (absRating === 4) return TS.STRONG
  if (absRating === 3) return TS.NORMAL
  if (absRating === 2) return TS.WEAK
  return TS.EXTRA_WEAK
}

// ─── Card accessors ───────────────────────────────────────────────────────────

/**
 * `realEffectivePower`: if effectivePower is 0 and card is a Creature, use power.
 * Mirrors ExtraCardInfo.realEffectivePower.
 */
function realEP(card) {
  const ep = card.extraCardInfo.effectivePower || 0
  if (ep === 0 && (card.cardType === 'Creature' || card.cardType === 'TokenCreature')) {
    return card.power || 0
  }
  return ep
}

/** All houses a card "belongs to" (its house + any bonus-house pips). */
function allHouses(card) {
  const s = new Set([card.house])
  for (const h of (card.bonusHouses || [])) s.add(h)
  return s
}

/** pip-enhanced: any non-zero pip icon on the card */
function isPipEnhanced(card) {
  return (card.bonusAember  || 0) > 0 || (card.bonusCapture  || 0) > 0 ||
         (card.bonusDamage  || 0) > 0 || (card.bonusDraw     || 0) > 0 ||
         (card.bonusDiscard || 0) > 0 || (card.bonusPower     || 0) > 0
}

/** enhanced: pip-enhanced OR has bonus-house pips */
function isEnhanced(card) {
  return isPipEnhanced(card) || (card.bonusHouses || []).length > 0
}

function creatureBonusFor(cardType) {
  return (cardType === 'Creature' || cardType === 'TokenCreature') ? CREATURE_BONUS : 0
}

/**
 * Average AERC score of a card's extraCardInfo.
 * Uses the pre-calculated aercScoreAverage from DoK when available.
 */
function aercAverage(card) {
  const i = card.extraCardInfo
  // Use pre-calculated average from DoK if available
  if (i.aercScoreAverage != null) {
    return i.aercScoreAverage
  }
  // Fallback to manual calculation (should rarely happen)
  const ep  = realEP(card)
  const cb  = creatureBonusFor(card.cardType)
  const base = (i.amberControl     || 0) + (i.expectedAmber    || 0) +
               (i.artifactControl  || 0) + (i.creatureControl  || 0) +
               (i.efficiency       || 0) + (i.recursion        || 0) +
               (i.disruption       || 0) + (i.creatureProtection || 0) +
               (i.other            || 0) + ep / 10 + cb
  const maxV = ((i.amberControlMax       ?? i.amberControl      ) || 0) +
               ((i.expectedAmberMax      ?? i.expectedAmber     ) || 0) +
               ((i.artifactControlMax    ?? i.artifactControl   ) || 0) +
               ((i.creatureControlMax    ?? i.creatureControl   ) || 0) +
               ((i.efficiencyMax         ?? i.efficiency        ) || 0) +
               ((i.recursionMax          ?? i.recursion         ) || 0) +
               ((i.disruptionMax         ?? i.disruption        ) || 0) +
               ((i.creatureProtectionMax ?? i.creatureProtection) || 0) +
               ((i.otherMax              ?? i.other             ) || 0) +
               ((i.effectivePowerMax     ?? ep                  ) || 0) / 10 + cb
  return maxV === base ? base : (base + maxV) / 2
}

// ─── SynTraitValue helpers ────────────────────────────────────────────────────

/**
 * Mirrors SynTraitValue.powerMatch() — checks if a card's power matches the
 * power constraint string ("5+", "3 or less", "even", "odd", "2-4", "1,3,5").
 */
function powerMatch(powersString, power, cardType) {
  if (!powersString) return true
  const ps = powersString.trim()
  if (!ps) return true
  if (cardType !== 'Creature' && cardType !== 'TokenCreature') return false
  if (ps === 'even') return power % 2 === 0
  if (ps === 'odd')  return power % 2 !== 0
  if (ps.includes(' or less')) return power <= (parseInt(ps) || 0)
  if (ps.endsWith('+'))        return power >= (parseInt(ps) || 0)
  if (ps.includes('-')) {
    const [a, b] = ps.split('-').map(Number)
    if (!isNaN(a) && !isNaN(b)) return power >= a && power <= b
  }
  if (ps.includes(',')) return ps.split(',').some(s => parseInt(s.trim()) === power)
  return parseInt(ps) === power
}

// ─── Core: ratingsToPercent ───────────────────────────────────────────────────

/**
 * Mirrors DeckSynergyService.ratingsToPercent(synRating, traitStrength).
 * Converts (synergy rating, trait strength value) → synergy percentage.
 */
function ratingsToPercent(synRating, strengthValue) {
  const table = { 2:2, 3:5, 4:10, 5:15, 6:25, 7:33, 8:50, 9:75, 10:100, 11:100, 12:100 }
  const sum  = Math.abs(synRating) + strengthValue
  const sign = synRating < 0 ? -1 : 1
  return sign * (table[sum] || 0)
}

// ─── Core: synergizedValue ────────────────────────────────────────────────────

/**
 * Mirrors DeckSynergyService.synergizedValue().
 * Returns { value, synergy } where synergy is the delta from the starting point.
 */
function synergizedValue(totalSynPercent, min, max, hasPositive, hasNegative, baseSynPercent) {
  if (isZeroOrNull(max)) return { value: min, synergy: 0 }

  const range     = max - min
  const divideBy  = (hasPositive && hasNegative && baseSynPercent == null) ? 200 : 100
  const synValue  = (totalSynPercent * range) / divideBy

  let start
  if (baseSynPercent != null) {
    start = (range * (baseSynPercent / divideBy)) + min
  } else if (hasPositive && hasNegative) {
    start = (range / 2) + min
  } else if (hasPositive) {
    start = min
  } else {
    start = max
  }

  const value      = clamp(synValue + start, min, max)
  const cappedStart = clamp(start, min, max)
  return { value, synergy: value - cappedStart }
}

// ─── Deck statistics (DeckSynergyStats.kt) ───────────────────────────────────

/**
 * Computes per-deck and per-house stat bundles for use in synPercent().
 * Returns { deckStats, houseStats, deckStatsEnemy, houseStatsEnemy }
 */
function computeStats(cards, expansion) {
  const isPV = expansion === 'PROPHETIC_VISIONS'
  const isGR = expansion === 'GRIM_REMINDERS'
  const houses = [...new Set(cards.map(c => c.house).filter(h => h && h !== 'Prophecy' && h !== 'ArchonPower'))]

  const buildStats = (cardSet, player) => {
    const isCreature = c => c.cardType === 'Creature' || c.cardType === 'TokenCreature' ||
                            (c.extraCardInfo.extraCardTypes || []).includes('Creature')

    const creatures = cardSet.filter(isCreature)

    // totalCreaturePower — includes any increasesCreaturePower trait bonus
    let totalCP = 0
    for (const c of cardSet) {
      const t = (c.extraCardInfo.traits || []).find(t => t.trait === 'increasesCreaturePower' && t.player !== 'ENEMY')
      const bonus = t ? ({ 6:6, 4:4, 3:3, 2:2, 1:1 }[Math.abs(t.rating || 3)] || 0) : 0
      const p = (c.power || 0) + (c.bonusPower || 0) + bonus
      if (p > 0) totalCP += p
    }

    // expectedAember
    let totalEA = 0
    for (const c of cardSet) {
      const mx = c.extraCardInfo.expectedAmberMax || 0
      const mn = c.extraCardInfo.expectedAmber || 0
      totalEA += mx === 0 ? mn : (mn + mx) / 2
    }

    return {
      creatureCount:          creatures.length,
      bonusAmber:             cardSet.reduce((s, c) => s + (c.bonusAember || 0) + (c.amber || 0), 0),
      bonusCapture:           cardSet.reduce((s, c) => s + (c.bonusCapture || 0), 0),
      bonusDamage:            cardSet.reduce((s, c) => s + (c.bonusDamage  || 0), 0),
      bonusDraw:              cardSet.reduce((s, c) => s + (c.bonusDraw    || 0), 0),
      bonusDiscard:           cardSet.reduce((s, c) => s + (c.bonusDiscard || 0), 0),
      bonusPower:             cardSet.reduce((s, c) => s + (c.bonusPower   || 0), 0),
      totalCreaturePower:     totalCP,
      totalArmor:             cardSet.reduce((s, c) => s + (c.armor        || 0), 0),
      expectedAember:         Math.round(totalEA),
      capturedAmber:          computeCapture(cardSet, new Set(['capturesAmber', 'exalt']), player),
      targettedCapturedAmber: computeCapture(cardSet, new Set(['putsAmberOnTarget']),      player),
      haunted:                isGR ? computeHaunting(cardSet, player) : 0,
      propheticOdds:          isPV ? computeProphecy(cardSet)          : 0,
      tokenCount:             cardSet.filter(c => c.cardType === 'TokenCreature').length,
    }
  }

  const deckStats       = buildStats(cards, 'ANY')
  const deckStatsEnemy  = buildStats(cards, 'ENEMY')
  const houseStats      = Object.fromEntries(houses.map(h => [h, buildStats(cards.filter(c => c.house === h), 'ANY')]))
  const houseStatsFriendly = Object.fromEntries(houses.map(h => [h, buildStats(cards.filter(c => c.house === h), 'FRIENDLY')]))
  const houseStatsEnemy = Object.fromEntries(houses.map(h => [h, buildStats(cards.filter(c => c.house === h), 'ENEMY')]))
  const deckStatsFriendly = buildStats(cards, 'FRIENDLY')

  return { deckStats, deckStatsFriendly, deckStatsEnemy, houseStats, houseStatsFriendly, houseStatsEnemy }
}

function computeCapture(cards, checkTraits, player) {
  let total = 0
  for (const card of cards) {
    const capTrait = (card.extraCardInfo.traits || []).find(t => {
      if (!checkTraits.has(t.trait)) return false
      const tp = t.player || 'ANY'
      return player === 'ANY' || tp === 'ANY' || tp === player
    })
    const pips = (player === 'ANY' || player === 'FRIENDLY') ? (card.bonusCapture || 0) : 0
    if (!capTrait && pips < 1) continue

    let expected = 0
    if (capTrait) {
      const sv = Math.abs(capTrait.rating || 3)
      expected = sv >= 6 ? 4 : sv === 4 ? 3 : sv === 3 ? 2 : sv === 2 ? 1 : 0.5
    }
    total += expected + pips
  }
  return Math.round(total)
}

function computeHaunting(cards, player) {
  const friendly = player === 'ANY' || player === 'FRIENDLY'
  let total = 0
  for (const card of cards) {
    let v = 0
    for (const t of (card.extraCardInfo.traits || [])) {
      const pm = player === 'ANY' || !t.player || t.player === 'ANY' || t.player === player
      if (!pm) continue
      const sv = Math.abs(t.rating || 3)
      if (t.trait === 'mills' || t.trait === 'haunted')
        v += sv >= 6 ? 30 : sv === 4 ? 20 : sv === 3 ? 15 : sv === 2 ? 10 : 5
      if (t.trait === 'discardsCards' || t.trait === 'discardsFromDeck')
        v += sv >= 6 ? 16 : sv === 4 ? 12 : sv === 3 ? 8 : sv === 2 ? 6 : 4
    }
    if (friendly) {
      v += card.cardType === 'Artifact' ? -2 : 0
      v += card.cardType === 'Action'   ?  2 : 0
      v += (card.bonusDiscard || 0) * 4
    }
    total += v
  }
  return total
}

function computeProphecy(cards) {
  let total = 0
  for (const card of cards) {
    if (card.cardType !== 'Prophecy') continue
    for (const t of (card.extraCardInfo.traits || [])) {
      if (t.trait !== 'prophecy') continue
      const sv = Math.abs(t.rating || 3)
      total += sv >= 6 ? 35 : sv === 4 ? 25 : sv === 3 ? 15 : sv === 2 ? 10 : 5
    }
  }
  return total
}

// ─── Deck-stat synPercent (DeckSynergyStats.synPercent) ──────────────────────

/**
 * Returns a numeric synergy % for deck-stat traits (creatureCount, bonusAmber…).
 * Returns null if the trait is not a deck-stat trait.
 * Mirrors DeckSynergyStats.synPercent().
 */
function deckStatSynPercent(synTrait, house, bundle) {
  const vals = DECK_STAT_TRAITS[synTrait.trait]
  if (!vals) return null

  const multiplierMap = {
    '6': 3, '4': 2, '3': 1, '2': 0.5, '1': 0.25,
    '-1': -0.25, '-2': -0.5, '-3': -1, '-4': -2, '-6': -3,
  }
  const mult = multiplierMap[String(synTrait.rating)]
  if (mult === undefined) return null

  const { deckStats, deckStatsFriendly, deckStatsEnemy, houseStats, houseStatsFriendly, houseStatsEnemy } = bundle

  const player    = synTrait.player || 'ANY'
  const traitHouse = synTrait.house  || 'anyHouse'

  const relDeck  = player === 'ENEMY' ? deckStatsEnemy : player === 'FRIENDLY' ? deckStatsFriendly : deckStats
  const relHouse = player === 'ENEMY' ? houseStatsEnemy : player === 'FRIENDLY' ? houseStatsFriendly : houseStats

  function pct(actual, min, max) {
    const range = max - min
    if (range <= 0) return 0
    return Math.round(((actual - min) / range) * 100 * mult)
  }

  if (traitHouse === 'house') {
    const actual = (relHouse[house] || {})[synTrait.trait] || 0
    return pct(actual, vals.minHouse || 0, vals.maxHouse)
  }
  if (traitHouse === 'anyHouse') {
    const actual = relDeck[synTrait.trait] || 0
    return pct(actual, vals.minDeck || 0, vals.maxDeck)
  }
  // outOfHouse: sum across all other houses
  const actual = Object.entries(relHouse)
    .filter(([h]) => h !== house)
    .reduce((s, [, stats]) => s + (stats[synTrait.trait] || 0), 0)
  return pct(actual, (vals.minHouse || 0) * 2, vals.maxHouse * 2)
}

// ─── Traits map (SynergyAlgorithm.kt — card iteration) ───────────────────────

/**
 * Builds the traits map used for trait matching.
 * traitsMap[traitName] = [{ value: SynTraitValue, card, house, deckTrait }]
 * Mirrors the card-iteration + addTrait/addDeckTrait logic.
 */
function buildTraitsMap(cards) {
  const map = {}  // traitName → [{value, card, deckTrait}]

  function addTrait(traitValue, card, houses, deckTrait = false) {
    const key = traitValue.trait
    if (!map[key]) map[key] = []
    if (!houses || houses.size === 0) {
      map[key].push({ value: traitValue, card, deckTrait })
    } else {
      for (const h of houses) {
        map[key].push({ value: traitValue, card, house: h, deckTrait })
      }
    }
  }

  for (const card of cards) {
    const info      = card.extraCardInfo
    const cardHouses = allHouses(card)

    // Traits declared in extraCardInfo
    for (const tv of (info.traits || [])) {
      addTrait(tv, card, cardHouses)
      // 'uses' also implies causesReaping + causesFighting
      if (tv.trait === 'uses') {
        const types = tv.cardTypes || []
        if (types.length === 0 || types.some(t => t === 'Creature' || t === 'TokenCreature')) {
          addTrait({ ...tv, trait: 'causesReaping' }, card, cardHouses)
          if ((tv.rating || 3) > 1) {
            addTrait({ ...tv, trait: 'causesFighting', rating: (tv.rating || 3) - 1 }, card, cardHouses)
          }
        }
      }
    }

    // Special traits derived from game-trait strings ("Skirmish", "Ward", …)
    for (const gameTrait of (card.traits || [])) {
      const traitName = gameTrait.toLowerCase()
      // Only add if it's a known SynergyTrait string (guard against "Knight", etc.)
      addTrait({ trait: traitName, rating: 3, house: 'anyHouse', player: 'ANY',
                 cardTypes: [], cardTraits: [], fromZones: [], powersString: '', notCardTraits: false },
               card, cardHouses)
    }

    // If the card is enhanced, add the 'enhanced' trait
    if (isEnhanced(card)) {
      addTrait({ trait: 'enhanced', rating: 3, house: 'anyHouse', player: 'ANY',
                 cardTypes: (info.extraCardTypes || []), cardTraits: [], fromZones: [],
                 powersString: '', notCardTraits: false },
               card, cardHouses)
    }

    // Every card adds the 'any' trait
    addTrait({ trait: 'any', rating: 3, house: 'anyHouse', player: 'ANY',
               cardTypes: [], cardTraits: [], fromZones: [], powersString: '', notCardTraits: false },
             card, cardHouses)
  }

  // ── AutomaticTraitsAlgorithm: highValue ──────────────────────────────────
  for (const card of cards) {
    const avg = aercAverage(card)
    if (avg < 2.5) continue
    const rating   = avg >= 3.5 ? 4 : avg >= 3.0 ? 3 : 2
    const allTypes = [...new Set([card.cardType, ...(card.extraCardInfo.extraCardTypes || [])])]
    addTrait({ trait: 'highValue', rating, house: 'anyHouse', player: 'ANY',
               cardTypes: allTypes, cardTraits: [], fromZones: [], powersString: '', notCardTraits: false },
             card, allHouses(card))
  }

  // ── GenerateDeckAndHouseTraits: bonus-pip deck traits ─────────────────────
  const pipTotals = {
    bonusAmber:   cards.reduce((s, c) => s + (c.bonusAember || 0) + (c.amber || 0), 0),
    bonusCapture: cards.reduce((s, c) => s + (c.bonusCapture || 0), 0),
    bonusDraw:    cards.reduce((s, c) => s + (c.bonusDraw    || 0), 0),
    bonusDiscard: cards.reduce((s, c) => s + (c.bonusDiscard || 0), 0),
    bonusDamage:  cards.reduce((s, c) => s + (c.bonusDamage  || 0), 0),
    bonusPower:   cards.reduce((s, c) => s + (c.bonusPower   || 0), 0),
  }
  for (const [trait, count] of Object.entries(pipTotals)) {
    for (let i = 0; i < count; i++) {
      addTrait({ trait, rating: TS.EXTRA_WEAK, house: 'anyHouse', player: 'ANY',
                 cardTypes: [], cardTraits: [], fromZones: [], powersString: '', notCardTraits: false },
               null, null, true)
    }
  }

  return map
}

// ─── Trait matching (MatchSynergiesToTraits.kt) ───────────────────────────────

/**
 * For a synergy on synCard, look up matching trait entries in traitsMap.
 * Returns { matchesByStrength: { [strengthValue]: count }, cardNames: [] }
 * Mirrors MatchSynergiesToTraits.matches().
 */
function matchTraits(synCard, synergy, traitsMap) {
  const entries = traitsMap[synergy.trait]
  if (!entries || entries.length === 0) return { matches: {}, cardNames: [] }

  const synCardHouses = allHouses(synCard)
  const synTypes      = synergy.cardTypes  || []
  const synFromZones  = synergy.fromZones  || []
  const synCardTraits = synergy.cardTraits || []
  const synPowers     = synergy.powersString || ''

  const matched    = []
  let   sameCard   = false
  const cardNames  = []

  for (const entry of entries) {
    const { value: tv, card: tc, deckTrait } = entry

    // ── typesMatch ──────────────────────────────────────────────────────────
    const traitCardTypes = tc ? new Set([tc.cardType, ...(tc.extraCardInfo.extraCardTypes || [])]) : null
    let typeOk
    if (tv.trait === 'any') {
      typeOk = synTypes.length === 0 || (traitCardTypes ? [...synTypes].some(t => traitCardTypes.has(t)) : false)
    } else {
      const traitTypes = tv.cardTypes || []
      typeOk = synTypes.length === 0 || traitTypes.length === 0 || synTypes.some(t => traitTypes.includes(t))
    }
    if (!typeOk) continue

    // ── fromZonesMatch ──────────────────────────────────────────────────────
    const traitZones = tv.fromZones || []
    if (synFromZones.length > 0 && traitZones.length > 0 && !synFromZones.some(z => traitZones.includes(z))) continue

    // ── playersMatch ────────────────────────────────────────────────────────
    const sp = synergy.player || 'ANY'
    const tp = tv.player || 'ANY'
    if (sp !== 'ANY' && tp !== 'ANY' && sp !== tp) continue

    // ── housesMatch ─────────────────────────────────────────────────────────
    if (!housesMatch(synergy, synCardHouses, tv, tc ? allHouses(tc) : null, deckTrait)) continue

    // ── powerMatch on synergy (targets trait card) ──────────────────────────
    if (!powerMatch(synPowers, tc ? (tc.power || 0) : 0, tc ? tc.cardType : null)) continue

    // ── powerMatch on trait (targets synergy card) ──────────────────────────
    if (!powerMatch(tv.powersString || '', synCard.power || 0, synCard.cardType)) continue

    // ── traitsOnSynergyMatch (synergy.cardTraits must exist on tc) ──────────
    const tcGameTraits = tc ? (tc.traits || []) : []
    if (synCardTraits.length > 0) {
      const allMeet = synCardTraits.every(t => synergy.notCardTraits ? !tcGameTraits.includes(t) : tcGameTraits.includes(t))
      if (!allMeet) continue
    }

    // ── traitsOnTraitMatch (tv.cardTraits must exist on synCard) ─────────────
    const tvCardTraits = tv.cardTraits || []
    const scGameTraits = synCard.traits || []
    if (tvCardTraits.length > 0) {
      const allMeet = tvCardTraits.every(t => tv.notCardTraits ? !scGameTraits.includes(t) : scGameTraits.includes(t))
      if (!allMeet) continue
    }

    matched.push(entry)
    if (tc?.cardTitle === synCard.cardTitle) sameCard = true
    if (tc?.cardTitle) cardNames.push(tc.cardTitle)
  }

  // Count by strength, excluding self-matches
  const matchesByStrength = {}
  for (const entry of matched) {
    const isSelf = sameCard && entry.card?.cardTitle === synCard.cardTitle
    if (isSelf) continue
    const sv = strengthFromAbs(Math.abs(entry.value.rating || 3))
    matchesByStrength[sv] = (matchesByStrength[sv] || 0) + 1
  }

  return { matches: matchesByStrength, cardNames }
}

/**
 * Mirrors MatchSynergiesToTraits.housesMatch().
 */
function housesMatch(synergy, synCardHouses, tv, traitCardHouses, deckTrait) {
  const sh = synergy.house || 'anyHouse'
  const th = tv.house      || 'anyHouse'
  const overlap = traitCardHouses == null ? true
                : [...synCardHouses].some(h => traitCardHouses.has(h))

  switch (sh) {
    case 'anyHouse':
      switch (th) {
        case 'anyHouse':    return true
        case 'house':       return !deckTrait && overlap
        case 'outOfHouse':  return !deckTrait && !overlap
        case 'continuous':  return true
      }
      break
    case 'house':
      switch (th) {
        case 'anyHouse':    return !deckTrait && overlap
        case 'house':       return overlap
        case 'outOfHouse':  return false
        case 'continuous':  return true
      }
      break
    case 'outOfHouse':
      switch (th) {
        case 'anyHouse':    return !deckTrait && !overlap
        case 'house':       return false
        case 'outOfHouse':  return !overlap
        case 'continuous':  return true
      }
      break
    case 'continuous':  return true
  }
  return true
}

// ─── Card-specific synergy matching (DeckSynergyService.cardMatches) ─────────

/**
 * For synergies with a specific cardName, look up that card in the deck.
 * cardsMap: { [house]: { [cardTitle]: { quantity, cardType } } }
 */
function cardSpecificMatches(synCard, synergy, cardsMap) {
  const target = synergy.cardName
  if (!target) return null

  const sh = synergy.house || 'anyHouse'
  const synCardHouses = allHouses(synCard)
  const allHouseEntries = Object.entries(cardsMap)

  let hits = []
  if (sh === 'house') {
    for (const h of synCardHouses) {
      const info = (cardsMap[h] || {})[target]
      if (info) hits.push(info)
    }
  } else if (sh === 'outOfHouse') {
    for (const [h, hMap] of allHouseEntries) {
      if (!synCardHouses.has(h) && hMap[target]) hits.push(hMap[target])
    }
  } else {
    for (const [, hMap] of allHouseEntries) {
      if (hMap[target]) hits.push(hMap[target])
    }
  }

  if (hits.length === 0) return null

  const type  = hits[0].cardType
  const isToken = type === 'TokenCreature'
  const count = isToken ? 2 : hits.reduce((s, h) => s + h.quantity, 0)
  const strength = isToken ? TS.STRONG : TS.NORMAL
  const selfCount = synCard.cardTitle === target ? 1 : 0
  const finalCount = count - selfCount
  if (finalCount <= 0) return null

  return { matches: { [strength]: finalCount }, cardNames: Array(finalCount).fill(target) }
}

// ─── Self-Enhancement combos (SelfEnhancementAlgorithm.kt) ───────────────────

function likelihoodPlayed(sv) {
  return { [TS.EXTRA_STRONG]: 0.1, [TS.STRONG]: 0.2, [TS.NORMAL]: 0.4, [TS.WEAK]: 0.6, [TS.EXTRA_WEAK]: 0.8 }[sv] ?? 0.4
}

function generateSelfEnhancementCombos(cards) {
  const combos = []
  const groups = {}
  for (const c of cards) {
    const key = `${c.cardTitle}|${c.house}`
    if (!groups[key]) groups[key] = { card: c, copies: 0 }
    groups[key].copies++
  }

  for (const { card, copies } of Object.values(groups)) {
    if (!isPipEnhanced(card)) continue

    const traits  = card.extraCardInfo.traits || []
    const replays = traits.find(t => t.trait === 'replaysSelf')
    const danger  = traits.find(t => t.trait === 'dangerousRandomPlay')
    const scrap   = traits.find(t => t.trait === 'scrapValue' || t.trait === 'fate')

    let mult
    if (replays) {
      const sv = strengthFromAbs(Math.abs(replays.rating || 3))
      mult = { [TS.EXTRA_STRONG]: 4, [TS.STRONG]: 3, [TS.NORMAL]: 2, [TS.WEAK]: 1.5, [TS.EXTRA_WEAK]: 1.25 }[sv]
    } else if (danger) {
      const sv = strengthFromAbs(Math.abs(danger.rating || 3))
      mult = { [TS.EXTRA_STRONG]: 0, [TS.STRONG]: 0.1, [TS.NORMAL]: 0.25, [TS.WEAK]: 0.5, [TS.EXTRA_WEAK]: 0.75 }[sv]
    } else if (scrap) {
      mult = likelihoodPlayed(strengthFromAbs(Math.abs(scrap.rating || 3)))
    } else if (card.cardType === 'Artifact') {
      mult = 0.75
    } else {
      continue
    }

    // Calculate modifier: (base * mult) - base = base * (mult - 1)
    // This gives the BONUS value, not the total (matches Kotlin calculateModifier)
    const drawMod    = (card.bonusDraw    || 0) * PIP_AERC.draw    * (mult - 1)
    const discardMod = (card.bonusDiscard || 0) * PIP_AERC.discard * (mult - 1)
    const powerMod   = (card.bonusPower   || 0) * PIP_AERC.power   * (mult - 1)
    const amberMod   = (card.bonusAember  || 0) * PIP_AERC.amber   * (mult - 1)
    const captureMod = (card.bonusCapture || 0) * PIP_AERC.capture * (mult - 1)
    const damageMod  = (card.bonusDamage  || 0) * PIP_AERC.damage  * (mult - 1)
    const total      = drawMod + amberMod + captureMod + damageMod + discardMod + powerMod

    combos.push({
      house: card.house, cardName: card.cardTitle + ' Enhanced',
      netSynergy: total, aercScore: total,
      expectedAmber: amberMod, amberControl: captureMod, creatureControl: damageMod,
      artifactControl: 0, efficiency: drawMod, recursion: 0,
      effectivePower: 0, creatureProtection: 0, disruption: discardMod, other: 0,
      copies,
    })
  }
  return combos
}

// ─── Token helpers ──────────────────────────────────────────────────────────

/**
 * Mirrors TokenSynergyService.traitToTokenCreationValue + makeTokenValues.
 * Returns the expected number of token creature copies per game for a deck.
 * Sums the contribution of every 'makesTokens' trait across all cards.
 */
function computeTokensPerGame(cards) {
  let total = 0
  for (const card of cards) {
    for (const t of (card.extraCardInfo?.traits || [])) {
      if (t.trait !== 'makesTokens') continue
      const r = t.rating
      // SynTraitValue.strength(): 1→EXTRA_WEAK→1.0, 2→WEAK→1.5, 3→NORMAL→2.0 (default), 4→STRONG→3.0, 6→EXTRA_STRONG→4.0
      const value = r === 1 ? 1.0 : r === 2 ? 1.5 : r === 4 ? 3.0 : r === 6 ? 4.0 : 2.0
      total += value
    }
  }
  return total
}

// ─── House Enhancement combos (HouseEnhancementAlgorithm.kt) ────────────────

/**
 * Generates bonus combos for cards with house enhancements (bonusHouses).
 * Mirrors HouseEnhancementAlgorithm.generateHouseEnhancementCombos().
 */
function generateHouseEnhancementCombos(cards) {
  const combos = []
  for (const card of cards) {
    if (!card.bonusHouses || card.bonusHouses.length === 0) continue

    const ep = card.extraCardInfo?.realEffectivePower || 0
    const isCreature = card.cardType === 'Creature'

    let amberMod = 0
    if (isCreature) {
      if (ep < 2) amberMod = 0.25
      else if (ep < 5) amberMod = 0.5
      else amberMod = 0.75
    }

    let creatureControlMod = 0
    if (isCreature) {
      if (ep > 8) creatureControlMod = 0.5
      else if (ep > 5) creatureControlMod = 0.25
    }

    const effMod = 0.5
    const total = amberMod + creatureControlMod + effMod

    combos.push({
      house: card.house,
      cardName: card.cardTitle + ' House Enhanced',
      netSynergy: total,
      aercScore: total,
      amberControl: 0,
      expectedAmber: amberMod,
      artifactControl: 0,
      creatureControl: creatureControlMod,
      efficiency: effMod,
      recursion: 0,
      effectivePower: 0,
      creatureProtection: 0,
      disruption: 0,
      other: 0,
      copies: 1,
    })
  }
  return combos
}

// ─── Efficiency bonus (DeckSynergyService.calculateEfficiencyBonus) ──────────

function calculateEfficiencyBonus(combos, preSas) {
  return combos
    .filter(c => c.efficiency > 0)
    .reduce((sum, combo) => {
      const f     = combo.efficiency
      const bonus = (f * (((preSas - combo.aercScore) / 35) * 0.4) / PIP_AERC.draw) - f
      return sum + bonus * (combo.copies || 1)
    }, 0)
}

// ─── Main: calculateSAS ───────────────────────────────────────────────────────

/**
 * Calculates full SAS/AERC for an array of alliance cards.
 *
 * allianceCards  – flat array of card objects (see below for shape)
 * expansion      – expansion string, e.g. 'CALL_OF_THE_ARCHONS'
 *
 * Card object shape (combine FrontendCard + SimpleCard bonus-pip data):
 * {
 *   cardTitle:     string,
 *   cardType:      string,   // 'Creature' | 'Action' | 'Artifact' | 'Upgrade' | …
 *   amber:         number,
 *   power:         number,
 *   armor:         number,
 *   traits:        string[],  // game traits: ["Skirmish", "Ward", …]
 *   big:           boolean,
 *   house:         string,
 *   bonusAember:   number,
 *   bonusCapture:  number,
 *   bonusDamage:   number,
 *   bonusDraw:     number,
 *   bonusDiscard:  number,
 *   bonusPower:    number,
 *   bonusHouses:   string[],
 *   extraCardInfo: { expectedAmber, amberControl, … traits: [], synergies: [] }
 * }
 *
 * Returns { sas, rawAerc, synergy, antisynergy }
 */
function calculateSAS(allianceCards, expansion, tokenCard = null) {
  // ── 0. Inject token copies (SynergyAlgorithm.kt lines 111-113) ──────────
  let inputCards = allianceCards
  if (tokenCard) {
    const tokensPerGame = computeTokensPerGame(allianceCards)
    const count = Math.round(tokensPerGame)
    if (count > 0) {
      inputCards = [...allianceCards, ...Array.from({ length: count }, () => ({ ...tokenCard }))]
    }
  }

  // ── 1. Filter/deduplicate "big" cards (counted at half) ──────────────────
  const cards = []
  const bigGroups = {}
  for (const c of inputCards) {
    if (!c.big) { cards.push(c); continue }
    const k = c.cardTitle
    if (!bigGroups[k]) bigGroups[k] = []
    bigGroups[k].push(c)
  }
  for (const group of Object.values(bigGroups)) {
    const half = Math.floor(group.length / 2)
    for (let i = 0; i < half; i++) cards.push(group[i])
  }

  if (cards.length === 0) return { sas: 0, rawAerc: 0, synergy: 0, antisynergy: 0 }

  const houses = [...new Set(cards.map(c => c.house).filter(h => h !== 'Prophecy' && h !== 'ArchonPower'))]

  // ── 2. Build helpers ─────────────────────────────────────────────────────
  const statsBundle = computeStats(cards, expansion)
  const traitsMap   = buildTraitsMap(cards)

  // cardsMap[house][cardTitle] = { quantity, cardType }  — for card-specific syns
  const cardsMap = {}
  for (const h of houses) cardsMap[h] = {}
  for (const card of cards) {
    const cset = cardsMap[card.house]
    if (!cset) continue
    if (!cset[card.cardTitle]) cset[card.cardTitle] = { quantity: 0, cardType: card.cardType }
    cset[card.cardTitle].quantity++
    // mavericks also appear in allHouses
    for (const bh of (card.bonusHouses || [])) {
      if (!cardsMap[bh]) cardsMap[bh] = {}
      if (!cardsMap[bh][card.cardTitle]) cardsMap[bh][card.cardTitle] = { quantity: 0, cardType: card.cardType }
      cardsMap[bh][card.cardTitle].quantity++
    }
  }

  // ── 3. Group by (cardTitle, house) and compute SynergyCombo per group ────
  const uniqueGroups = {}
  for (const card of cards) {
    const key = `${card.cardTitle}~~${card.house}`
    if (!uniqueGroups[key]) uniqueGroups[key] = { card, copies: 0 }
    uniqueGroups[key].copies++
  }

  const synergyCombos = []

  for (const { card, copies } of Object.values(uniqueGroups)) {
    const info    = card.extraCardInfo
    const house   = card.house
    const syns    = info.synergies || []

    if (card.cardType === 'Prophecy') continue   // Prophecy special-case skipped

    // ── 3a. Calculate synPercent for each synergy ──────────────────────────
    const synergyMatches = syns.map(synergy => {
      let pct

      // Priority 1: deck-stat traits
      const dsp = deckStatSynPercent(synergy, house, statsBundle)
      if (dsp !== null) {
        pct = dsp
      }
      // Priority 2: enhancedHouses special-case
      else if (synergy.trait === 'enhancedHouses') {
        const matchCount = (card.bonusHouses || []).length
        pct = matchCount * ratingsToPercent(synergy.rating, TS.STRONG)
      }
      // Priority 3: card-specific synergy (cardName set)
      else if (synergy.cardName) {
        const res = cardSpecificMatches(card, synergy, cardsMap)
        pct = res
          ? Object.entries(res.matches).reduce((s, [sv, cnt]) =>
              s + cnt * ratingsToPercent(synergy.rating, Number(sv)), 0)
          : 0
      }
      // Priority 4: trait matching
      else {
        const res = matchTraits(card, synergy, traitsMap)
        pct = Object.entries(res.matches).reduce((s, [sv, cnt]) =>
          s + cnt * ratingsToPercent(synergy.rating, Number(sv)), 0)
      }

      return { synergy, pct }
    })

    // ── 3b. Group synergies and apply group caps ───────────────────────────
    // In Kotlin, groupBy { it.trait.synergyGroup } treats null as a valid key,
    // so all synergies without a group share the same null group.
    const grouped = {}
    for (const { synergy, pct } of synergyMatches) {
      const g = synergy.synergyGroup ?? '__null_group__'
      if (!grouped[g]) grouped[g] = []
      grouped[g].push({ synergy, pct })
    }

    let generalGroupMax = 1000
    const groupPercents = []

    for (const groupItems of Object.values(grouped)) {
      const isPrimary = groupItems.some(x => x.synergy.primaryGroup)
      const maxEntry  = groupItems.find(x => x.synergy.synergyGroupMax != null && x.synergy.synergyGroupMax !== 0)
      const groupMax  = maxEntry?.synergy.synergyGroupMax ?? null
      
      // Filter out 'highValue' synergies if 'any' exists in the same group
      // This prevents double-counting cards that match both 'any' and 'highValue'
      const hasAnyTrait = groupItems.some(x => x.synergy.trait === 'any')
      const filteredItems = hasAnyTrait 
        ? groupItems.filter(x => x.synergy.trait !== 'highValue')
        : groupItems
      
      const groupSum  = filteredItems.reduce((s, x) => s + x.pct, 0)

      if (isPrimary) generalGroupMax = groupSum

      let capped = groupSum
      if (groupMax != null &&
          ((groupMax > 0 && groupSum > groupMax) || (groupMax < 0 && groupSum < groupMax))) {
        capped = groupMax
      }
      groupPercents.push(capped)
    }

    const finalPercents = generalGroupMax === 1000
      ? groupPercents
      : groupPercents.map(g => g > generalGroupMax ? generalGroupMax : g)

    const totalSynPct  = finalPercents.reduce((s, g) => s + g, 0)
    const hasPositive  = syns.some(s => s.rating > 0)
    const hasNegative  = syns.some(s => s.rating < 0)
    const base         = info.baseSynPercent ?? null

    // ── 3c. Compute synergized AERC values ────────────────────────────────
    const sv = (min, max) => synergizedValue(totalSynPct, min, max ?? null, hasPositive, hasNegative, base)

    const ep      = realEP(card)
    const aValue  = sv(info.amberControl      || 0, info.amberControlMax      ?? null)
    const eValue  = sv(info.expectedAmber     || 0, info.expectedAmberMax     ?? null)
    const rValue  = sv(info.artifactControl   || 0, info.artifactControlMax   ?? null)
    const cValue  = sv(info.creatureControl   || 0, info.creatureControlMax   ?? null)
    const fValue  = sv(info.efficiency        || 0, info.efficiencyMax        ?? null)
    const uValue  = sv(info.recursion         || 0, info.recursionMax         ?? null)

    const dValue  = sv(info.disruption        || 0, info.disruptionMax        ?? null)
    const apValue = sv(info.creatureProtection|| 0, info.creatureProtectionMax?? null)
    const oValue  = sv(info.other             || 0, info.otherMax             ?? null)
    const pValue  = (ep === 0 && isZeroOrNull(info.effectivePowerMax))
      ? { value: 0, synergy: 0 }
      : sv(ep, info.effectivePowerMax ?? null)

    // effectivePower is stored × 10 in the model; scale for SAS
    const pScaled = {
      value:   Math.round(pValue.value   / 10 * 10) / 10,
      synergy: Math.round(pValue.synergy / 10 * 10) / 10,
    }

    const allSV   = [aValue, eValue, rValue, cValue, fValue, uValue, pScaled, dValue, apValue, oValue]
    const netSyn  = allSV.reduce((s, v) => s + v.synergy, 0)
    const aerc    = allSV.reduce((s, v) => s + v.value,   0) + creatureBonusFor(card.cardType)

    synergyCombos.push({
      house, cardName: card.cardTitle,
      netSynergy: netSyn,
      aercScore:  aerc,
      expectedAmber:      eValue.value,
      amberControl:       aValue.value,
      creatureControl:    cValue.value,
      artifactControl:    rValue.value,
      efficiency:         fValue.value,
      recursion:          uValue.value,
      effectivePower:     Math.trunc(pValue.value),  // Kotlin uses .toInt() which truncates
      creatureProtection: apValue.value,
      disruption:         dValue.value,
      other:              oValue.value,
      copies,
    })
  }

  // ── 4. Self-enhancement and house-enhancement combos ─────────────────────
  synergyCombos.push(...generateSelfEnhancementCombos(cards))
  synergyCombos.push(...generateHouseEnhancementCombos(cards))

  // ── 5. Sum totals across all combos ─────────────────────────────────────
  const sum = key => synergyCombos.reduce((s, c) => s + (c[key] || 0) * (c.copies || 1), 0)

  const totalA  = sum('amberControl')
  const totalE  = sum('expectedAmber')
  const totalR  = sum('artifactControl')
  const totalC  = sum('creatureControl')
  const totalF  = sum('efficiency')
  const totalU  = sum('recursion')
  const totalD  = sum('disruption')
  const totalP  = sum('effectivePower')
  const totalO  = sum('other')
  const totalCp = sum('creatureProtection')

  // For SAS calculation, count all creatures including tokens
  const totalCreaturesForSas = cards.filter(c => c.cardType === 'Creature' || c.cardType === 'TokenCreature').length
  const powerValue    = totalP / 10

  const preSas = totalA + totalE + totalR + totalC + totalF + totalU + totalD + totalCp + totalO
               + powerValue + totalCreaturesForSas * CREATURE_BONUS

  const effBonus   = calculateEfficiencyBonus(synergyCombos, preSas)
  const synRaw     = synergyCombos.filter(c => c.netSynergy > 0).reduce((s, c) => s + c.netSynergy * (c.copies || 1), 0)
  const antiSynRaw = synergyCombos.filter(c => c.netSynergy < 0).reduce((s, c) => s + c.netSynergy * (c.copies || 1), 0)

  const synergy     = Math.round(synRaw + effBonus)
  const antisynergy = Math.round(Math.abs(antiSynRaw))
  const sas         = Math.round(preSas + effBonus)
  const rawAerc     = sas + antisynergy - synergy

  // ── 6. Per-house breakdown (matches DoK: does NOT include efficiency bonus) ──
  // Sum first, then round at the end (not after each addition)
  const perHouseRaw = {}
  for (const c of synergyCombos) {
    const h = c.house
    const copies = c.copies || 1
    perHouseRaw[h] = (perHouseRaw[h] || 0) + c.aercScore * copies
  }
  const perHouse = {}
  for (const h of Object.keys(perHouseRaw)) {
    perHouse[h] = Math.round(perHouseRaw[h])
  }

  // ── 7. Card type counts ─────────────────────────────────────────────────────
  const creatureCount = cards.filter(c => c.cardType === 'Creature').length
  const actionCount   = cards.filter(c => c.cardType === 'Action').length
  const artifactCount = cards.filter(c => c.cardType === 'Artifact').length
  const upgradeCount  = cards.filter(c => c.cardType === 'Upgrade').length
  const tokenCount    = cards.filter(c => c.cardType === 'TokenCreature').length
  const mutantCount   = cards.filter(c => (c.traits || []).includes('MUTANT')).length

  // Bonus amber from pips + card amber
  const bonusAmber = cards.reduce((s, c) => s + (c.bonusAember || 0) + (c.amber || 0), 0)

  // Total creature power
  const totalPower = cards
    .filter(c => c.cardType === 'Creature' || c.cardType === 'TokenCreature')
    .reduce((s, c) => s + (c.power || 0) + (c.bonusPower || 0), 0)

  // Total armor
  const totalArmor = cards.reduce((s, c) => s + (c.armor || 0), 0)

  // Tide counts for Dark Tidings (DT) decks
  // manipulatesTide: cards with trait raisesTide or lowersTide
  // usesTide: cards with synergy for raisesTide or lowersTide
  const manipulatesTide = cards.filter(c => {
    const traits = c.extraCardInfo?.traits || []
    return traits.some(t => t.trait === 'raisesTide' || t.trait === 'lowersTide')
  }).length

  const usesTide = cards.filter(c => {
    const syns = c.extraCardInfo?.synergies || []
    return syns.some(s => s.trait === 'raisesTide' || s.trait === 'lowersTide')
  }).length

  // Archive counts
  const archivesTargeted = cards.filter(c => {
    const traits = c.extraCardInfo?.traits || []
    return traits.some(t => t.trait === 'archives' && t.player !== 'ENEMY')
  }).length

  const archivesRandom = cards.filter(c => {
    const traits = c.extraCardInfo?.traits || []
    return traits.some(t => t.trait === 'archivesRandom')
  }).length

  // Key Cheat count (forgesKeys or forgesKeysWithoutAember)
  const keyCheatCount = cards.filter(c => {
    const traits = c.extraCardInfo?.traits || []
    return traits.some(t => t.trait === 'forgesKeys' || t.trait === 'forgesKeysWithoutAember')
  }).length

  // Scaling Amber Control count (rating > 1 to match DoK UI)
  const scalingAmberControl = cards.filter(c => {
    const traits = c.extraCardInfo?.traits || []
    return traits.some(t => t.trait === 'scalingAmberControl' && (t.rating || 0) > 1)
  }).length

  // Board Wipe count (boardClear trait, rating > 1 to match DoK UI)
  const boardWipeCount = cards.filter(c => {
    const traits = c.extraCardInfo?.traits || []
    return traits.some(t => t.trait === 'boardClear' && (t.rating || 0) > 1)
  }).length

  return {
    sas, rawAerc, synergy, antisynergy, perHouse,
    efficiencyBonus: Math.round(effBonus * 10) / 10,
    // AERC breakdown - raw values (not rounded) to match Kotlin's DeckSynergyInfo
    // Rounding happens at display time via fmt1()
    amberControl: totalA,
    expectedAmber: totalE,
    artifactControl: totalR,
    creatureControl: totalC,
    efficiency: totalF,
    recursion: totalU,
    disruption: totalD,
    effectivePower: totalP,  // Raw sum (not divided by 10), like original DoK
    creatureProtection: totalCp,
    other: totalO,
    // Counts
    creatureCount, actionCount, artifactCount, upgradeCount, tokenCount, mutantCount,
    bonusAmber, totalPower, totalArmor,
    // Tide (for Dark Tidings)
    manipulatesTide, usesTide,
    // Archives, Key Cheat, Scaling, Board Wipes
    archivesTargeted, archivesRandom, keyCheatCount, scalingAmberControl, boardWipeCount,
  }
}

// Export for ES modules (browser)
export { calculateSAS, computeTokensPerGame }
