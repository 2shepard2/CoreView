// Ported unchanged from CoreView V1 server/sports-watchlist.js.
// Pure game selection: persisted decisions, no timers, network or display writes.
const MODES = new Set(['auto', 'pin', 'pause']);
function normalize(value = {}) {
  const seen = new Set();
  const teams = (Array.isArray(value.teams) ? value.teams : []).slice(0, 64).flatMap(row => {
    if (!row || typeof row !== 'object') return [];
    const entityId = String(row.entityId || '').trim().toLowerCase();
    if (!/^sensor\.[a-z0-9_]+$/.test(entityId) || seen.has(entityId)) return [];
    seen.add(entityId);
    return [{ entityId, name: String(row.name || entityId).slice(0, 80), enabled: row.enabled !== false }];
  });
  return {
    mode: MODES.has(value.mode) ? value.mode : 'pause',
    pinnedEntityId: String(value.pinnedEntityId || '').trim().toLowerCase(),
    widgetId: String(value.widgetId || 'sports-scoreboard').trim().toLowerCase(),
    teams
  };
}
function eventKey(entity) {
  const a = entity?.attributes || {};
  // Provider/league scope avoids collisions between sports' event IDs.
  return a.event_id ? `${a.league || a.sport || ''}:${a.event_id}` : `${entity?.entityId}:${a.date || ''}`;
}
function select(config, entities, previous = {}, now = Date.now()) {
  const rows = config.teams.filter(row => row.enabled);
  const map = new Map(entities.map(entity => [entity.entityId, entity]));
  const currentRow = rows.find(row => row.entityId === previous.entityId);
  const current = currentRow ? map.get(currentRow.entityId) : null;
  const empty = { entityId: null, eventKey: null, phase: 'idle', finalUntil: null, unavailableSince: null };
  const choose = (entity, phase = 'live') => ({ ...empty, entityId: entity.entityId, eventKey: eventKey(entity), phase });
  if (config.mode === 'pause') return { ...empty, phase: 'paused' };
  if (config.mode === 'pin') {
    const row = rows.find(row => row.entityId === config.pinnedEntityId);
    if (!row) return empty;
    return { ...empty, entityId: row.entityId, eventKey: eventKey(map.get(row.entityId)), phase: 'pinned' };
  }
  const live = rows.map(row => map.get(row.entityId)).filter(entity => entity?.state === 'IN');
  const best = live[0];
  const currentIndex = rows.indexOf(currentRow);
  const bestIndex = rows.findIndex(row => row.entityId === best?.entityId);
  // Hold the current identity briefly during a missing entity/HA connection.
  // A higher-ranked live game can still take over during that recovery window.
  const missing = currentRow && (!current || ['unknown', 'unavailable', 'NOT_FOUND'].includes(current.state));
  if (missing && (!previous.finalUntil || (now < previous.finalUntil && !best))) {
    const since = previous.unavailableSince ?? now;
    if (now - since < 60000 && (!best || bestIndex >= currentIndex)) {
      return { ...previous, phase: 'recovering', unavailableSince: since };
    }
  }
  if (best) return choose(best);
  if (current?.state === 'POST' && eventKey(current) === previous.eventKey && ['live', 'recovering', 'final'].includes(previous.phase)) {
    const changed = Date.parse(current.lastChangedAt || '');
    const until = previous.finalUntil ?? (Math.min(now, Number.isFinite(changed) ? changed : now) + 300000);
    if (now < until) return { ...choose(current, 'final'), finalUntil: until };
  }
  return empty;
}
function otherGames(config, entities, selectedId) {
  const map = new Map(entities.map(entity => [entity.entityId, entity]));
  const seen = new Set();
  if (map.has(selectedId)) seen.add(eventKey(map.get(selectedId)));
  return config.teams.filter(row => row.enabled).flatMap(row => {
    const entity = map.get(row.entityId);
    if (entity?.state !== 'IN' || seen.has(eventKey(entity))) return [];
    seen.add(eventKey(entity));
    const a = entity.attributes;
    return [`LIVE ${a.team_abbr || row.name} ${a.team_score ?? '--'} ${a.opponent_abbr || 'OPP'} ${a.opponent_score ?? '--'}`];
  });
}
module.exports = { normalize, select, otherGames, eventKey };
