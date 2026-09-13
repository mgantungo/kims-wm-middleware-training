// src/utils/locationAccess.js

/**
 * Restricts what an operator can see/reach to their own Business Central
 * location. Shared by putAway.controller.js and inquiry.controller.js —
 * both need the identical rule, just against differently-shaped data
 * (put-away documents use `locationCode`; a single Bin Inquiry search
 * result uses `location` instead — see businessCentralDataSource.js's
 * searchBin vs listBins for why the field name differs). Rather than
 * assume a field name, every function here takes the already-extracted
 * locationCode value (or an accessor for a list), so callers stay
 * responsible for reading their own shape correctly.
 *
 * The operator's own locationCode always comes from req.user.locationCode
 * — a verified JWT claim (see requireAuth.js / jwtService.js), never a
 * client-supplied query or body parameter. A parameter the app sends can
 * be omitted or altered; a claim verified server-side cannot.
 *
 * Deliberately permissive when either side has no location to compare:
 * demo data has no locationCode concept at all, and not every local
 * account has had locationCode added to its users.json entry yet. A
 * document/bin with no locationCode, or an operator with none, is
 * shown/reachable exactly as it always was — restriction only activates
 * once BOTH sides have a real, comparable value. This is the same
 * additive-only philosophy applied to every other Business Central field
 * added to this app; it is NOT a security bug, since "unrestricted for
 * unconfigured accounts/data" is the deliberate rollout path, not an
 * accidental bypass.
 */

function locationsMatch(entityLocationCode, userLocationCode) {
  if (!userLocationCode || !entityLocationCode) return true;
  return entityLocationCode === userLocationCode;
}

/** For a single fetched entity — throws the caller's own notFound error
 * (via the `onDenied` callback) rather than returning a boolean, so a
 * denied entity comes back as 404, not 403: an operator outside a
 * location shouldn't be able to tell from the response whether the
 * thing exists at all, only that they can't reach it. */
function assertVisible(entityLocationCode, req, onDenied) {
  if (!locationsMatch(entityLocationCode, req.user && req.user.locationCode)) {
    onDenied();
  }
}

/** For a list — `getLocationCode(entity)` extracts whichever field that
 * entity's shape actually uses. */
function filterByLocation(entities, req, getLocationCode) {
  const userLocationCode = req.user && req.user.locationCode;
  return (entities || []).filter((e) => locationsMatch(getLocationCode(e), userLocationCode));
}

module.exports = { locationsMatch, assertVisible, filterByLocation };