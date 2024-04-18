const Metrics = require('@overleaf/metrics')
const UserUpdater = require('../User/UserUpdater')
const AnalyticsManager = require('../Analytics/AnalyticsManager')
const LocalsHelper = require('./LocalsHelper')
const crypto = require('crypto')
const _ = require('lodash')
const { callbackify } = require('util')
const SplitTestCache = require('./SplitTestCache')
const { SplitTest } = require('../../models/SplitTest')
const UserAnalyticsIdCache = require('../Analytics/UserAnalyticsIdCache')
const Features = require('../../infrastructure/Features')
const SplitTestUtils = require('./SplitTestUtils')
const Settings = require('@overleaf/settings')
const SessionManager = require('../Authentication/SessionManager')
const logger = require('@overleaf/logger')
const SplitTestSessionHandler = require('./SplitTestSessionHandler')
const SplitTestUserGetter = require('./SplitTestUserGetter')

const DEFAULT_VARIANT = 'default'
const ALPHA_PHASE = 'alpha'
const BETA_PHASE = 'beta'
const DEFAULT_ASSIGNMENT = {
  variant: DEFAULT_VARIANT,
  analytics: {
    segmentation: {},
  },
}

/**
 * Get the assignment of a user to a split test and store it in the response locals context
 *
 * @example
 * // Assign user and record an event
 *
 * const assignment = await SplitTestHandler.getAssignment(req, res, 'example-project')
 * if (assignment.variant === 'awesome-new-version') {
 *   // execute my awesome change
 * }
 * else {
 *   // execute the default behaviour (control group)
 * }
 * // then record an event
 * AnalyticsManager.recordEventForSession(req.session, 'example-project-created', {
 *   projectId: project._id,
 *   ...assignment.analytics.segmentation
 * })
 *
 * @param req the request
 * @param res the Express response object
 * @param splitTestName the unique name of the split test
 * @param options {Object<sync: boolean>} - for test purposes only, to force the synchronous update of the user's profile
 * @returns {Promise<{variant: string, analytics: {segmentation: {splitTest: string, variant: string, phase: string, versionNumber: number}|{}}}>}
 */
async function getAssignment(req, res, splitTestName, { sync = false } = {}) {
  const query = req.query || {}
  let assignment

  try {
    if (!Features.hasFeature('saas')) {
      assignment = _getNonSaasAssignment(splitTestName)
    } else {
      await _loadSplitTestInfoInLocals(res.locals, splitTestName, req.session)

      // Check the query string for an override, ignoring an invalid value
      const queryVariant = query[splitTestName]
      if (queryVariant) {
        const variants = await _getVariantNames(splitTestName)
        if (variants.includes(queryVariant)) {
          assignment = {
            variant: queryVariant,
            analytics: {
              segmentation: {},
            },
          }
        }
      }

      if (!assignment) {
        const { userId, analyticsId } = AnalyticsManager.getIdsFromSession(
          req.session
        )
        assignment = await _getAssignment(splitTestName, {
          analyticsId,
          userId,
          session: req.session,
          sync,
        })
        SplitTestSessionHandler.collectSessionStats(req.session)
      }
    }
  } catch (error) {
    logger.error({ err: error }, 'Failed to get split test assignment')
    assignment = DEFAULT_ASSIGNMENT
  }

  LocalsHelper.setSplitTestVariant(
    res.locals,
    splitTestName,
    assignment.variant
  )

  return assignment
}

/**
 * Get the assignment of a user to a split test by their user ID.
 *
 * Warning: this does not support query parameters override, nor makes the assignment and split test info available to
 * the frontend through locals. Wherever possible, `getAssignment` should be used instead.
 *
 * @param userId the user ID
 * @param splitTestName the unique name of the split test
 * @param options {Object<sync: boolean>} - for test purposes only, to force the synchronous update of the user's profile
 * @returns {Promise<{variant: string, analytics: {segmentation: {splitTest: string, variant: string, phase: string, versionNumber: number}|{}}}>}
 */
async function getAssignmentForUser(
  userId,
  splitTestName,
  { sync = false } = {}
) {
  try {
    if (!Features.hasFeature('saas')) {
      return _getNonSaasAssignment(splitTestName)
    }

    const analyticsId = await UserAnalyticsIdCache.get(userId)
    return _getAssignment(splitTestName, { analyticsId, userId, sync })
  } catch (error) {
    logger.error({ err: error }, 'Failed to get split test assignment for user')
    return DEFAULT_ASSIGNMENT
  }
}

/**
 * Get the assignment of a user to a split test by their pre-fetched mongo doc.
 *
 * Warning: this does not support query parameters override, nor makes the assignment and split test info available to
 * the frontend through locals. Wherever possible, `getAssignment` should be used instead.
 *
 * @param user the user
 * @param splitTestName the unique name of the split test
 * @param options {Object<sync: boolean>} - for test purposes only, to force the synchronous update of the user's profile
 * @returns {Promise<{variant: string, analytics: {segmentation: {splitTest: string, variant: string, phase: string, versionNumber: number}|{}}}>}
 */
async function getAssignmentForMongoUser(
  user,
  splitTestName,
  { sync = false } = {}
) {
  try {
    if (!Features.hasFeature('saas')) {
      return _getNonSaasAssignment(splitTestName)
    }

    return _getAssignment(splitTestName, {
      analyticsId: await UserAnalyticsIdCache.get(user._id),
      sync,
      user,
      userId: user._id.toString(),
    })
  } catch (error) {
    logger.error(
      { err: error },
      'Failed to get split test assignment for mongo user'
    )
    return DEFAULT_ASSIGNMENT
  }
}

/**
 * Get a mapping of the active split test assignments for the given user
 */
async function getActiveAssignmentsForUser(userId, removeArchived = false) {
  if (!Features.hasFeature('saas')) {
    return {}
  }

  const user = await SplitTestUserGetter.promises.getUser(userId)
  if (user == null) {
    return {}
  }

  const splitTests = await SplitTest.find({
    $where: 'this.versions[this.versions.length - 1].active',
    ...(removeArchived && { archived: { $ne: true } }),
  }).exec()
  const assignments = {}
  for (const splitTest of splitTests) {
    const { activeForUser, selectedVariantName, phase, versionNumber } =
      await _getAssignmentMetadata(user.analyticsId, user, splitTest)
    if (activeForUser) {
      const assignment = {
        variantName: selectedVariantName,
        versionNumber,
        phase,
      }
      const userAssignments = user.splitTests?.[splitTest.name]
      if (Array.isArray(userAssignments)) {
        const userAssignment = userAssignments.find(
          x => x.versionNumber === versionNumber
        )
        if (userAssignment) {
          assignment.assignedAt = userAssignment.assignedAt
        }
      }
      assignments[splitTest.name] = assignment
    }
  }
  return assignments
}

/**
 * Returns an array of valid variant names for the given split test, including default
 *
 * @param splitTestName
 * @returns {Promise<string[]>}
 * @private
 */
async function _getVariantNames(splitTestName) {
  const splitTest = await _getSplitTest(splitTestName)
  const currentVersion = SplitTestUtils.getCurrentVersion(splitTest)
  if (currentVersion?.active) {
    return currentVersion.variants.map(v => v.name).concat([DEFAULT_VARIANT])
  } else {
    return [DEFAULT_VARIANT]
  }
}

async function _getAssignment(
  splitTestName,
  { analyticsId, user, userId, session, sync }
) {
  if (!analyticsId && !userId) {
    return DEFAULT_ASSIGNMENT
  }

  const splitTest = await _getSplitTest(splitTestName)
  const currentVersion = SplitTestUtils.getCurrentVersion(splitTest)

  if (Settings.splitTest.devToolbar.enabled) {
    const override = session?.splitTestOverrides?.[splitTestName]
    if (override) {
      return _makeAssignment(splitTest, override, currentVersion)
    }
  }

  if (!currentVersion?.active) {
    return DEFAULT_ASSIGNMENT
  }

  // Do not cache assignments for anonymous users. All the context for their assignments is in the session:
  // They cannot be part of the alpha or beta program, and they will use their analyticsId for assignments.
  const canUseSessionCache = session && SessionManager.isUserLoggedIn(session)
  if (session && !canUseSessionCache) {
    // Purge the existing cache
    delete session.cachedSplitTestAssignments
  }

  if (canUseSessionCache) {
    const cachedVariant = SplitTestSessionHandler.getCachedVariant(
      session,
      splitTest.name,
      currentVersion
    )

    if (cachedVariant) {
      Metrics.inc('split_test_get_assignment_source', 1, { status: 'cache' })
      if (
        cachedVariant ===
        SplitTestSessionHandler.CACHE_TOMBSTONE_SPLIT_TEST_NOT_ACTIVE_FOR_USER
      ) {
        return DEFAULT_ASSIGNMENT
      } else {
        return _makeAssignment(splitTest, cachedVariant, currentVersion)
      }
    }
  }

  if (user) {
    Metrics.inc('split_test_get_assignment_source', 1, { status: 'provided' })
  } else if (userId) {
    Metrics.inc('split_test_get_assignment_source', 1, { status: 'mongo' })
  } else {
    Metrics.inc('split_test_get_assignment_source', 1, { status: 'none' })
  }

  user =
    user ||
    (userId &&
      (await SplitTestUserGetter.promises.getUser(userId, splitTestName)))
  const { activeForUser, selectedVariantName, phase, versionNumber } =
    await _getAssignmentMetadata(analyticsId, user, splitTest)
  if (canUseSessionCache) {
    SplitTestSessionHandler.setVariantInCache({
      session,
      splitTestName,
      currentVersion,
      selectedVariantName,
      activeForUser,
    })
  }
  if (activeForUser) {
    if (currentVersion.analyticsEnabled) {
      // if the user is logged in, persist the assignment
      if (userId) {
        const assignmentData = {
          user,
          userId,
          splitTestName,
          phase,
          versionNumber,
          variantName: selectedVariantName,
        }
        if (sync === true) {
          await _recordAssignment(assignmentData)
        } else {
          _recordAssignment(assignmentData)
        }
      }
      // otherwise this is an anonymous user, we store assignments in session to persist them on registration
      else {
        await SplitTestSessionHandler.promises.appendAssignment(session, {
          splitTestId: splitTest._id,
          splitTestName,
          phase,
          versionNumber,
          variantName: selectedVariantName,
          assignedAt: new Date(),
        })
      }

      AnalyticsManager.setUserPropertyForAnalyticsId(
        user?.analyticsId || analyticsId || userId,
        `split-test-${splitTestName}-${versionNumber}`,
        selectedVariantName
      )
    }
    return _makeAssignment(splitTest, selectedVariantName, currentVersion)
  }

  return DEFAULT_ASSIGNMENT
}

async function _getAssignmentMetadata(analyticsId, user, splitTest) {
  const currentVersion = SplitTestUtils.getCurrentVersion(splitTest)
  const phase = currentVersion.phase
  if (
    (phase === ALPHA_PHASE && !user?.alphaProgram) ||
    (phase === BETA_PHASE && !user?.betaProgram)
  ) {
    return {
      activeForUser: false,
    }
  }
  const userId = user?._id.toString()
  const percentile = getPercentile(analyticsId || userId, splitTest.name, phase)
  const selectedVariantName = _getVariantFromPercentile(
    currentVersion.variants,
    percentile
  )
  return {
    activeForUser: true,
    selectedVariantName: selectedVariantName || DEFAULT_VARIANT,
    phase,
    versionNumber: currentVersion.versionNumber,
  }
}

function getPercentile(analyticsId, splitTestName, splitTestPhase) {
  const hash = crypto
    .createHash('md5')
    .update(analyticsId + splitTestName + splitTestPhase)
    .digest('hex')
  const hashPrefix = hash.substr(0, 8)
  return Math.floor(
    ((parseInt(hashPrefix, 16) % 0xffffffff) / 0xffffffff) * 100
  )
}

function setOverrideInSession(session, splitTestName, variantName) {
  if (!Settings.splitTest.devToolbar.enabled) {
    return
  }
  if (!session.splitTestOverrides) {
    session.splitTestOverrides = {}
  }
  session.splitTestOverrides[splitTestName] = variantName
}

function clearOverridesInSession(session) {
  delete session.splitTestOverrides
}

function _getVariantFromPercentile(variants, percentile) {
  for (const variant of variants) {
    for (const stripe of variant.rolloutStripes) {
      if (percentile >= stripe.start && percentile < stripe.end) {
        return variant.name
      }
    }
  }
}

async function _recordAssignment({
  user,
  userId,
  splitTestName,
  phase,
  versionNumber,
  variantName,
}) {
  const persistedAssignment = {
    variantName,
    versionNumber,
    phase,
    assignedAt: new Date(),
  }
  user =
    user || (await SplitTestUserGetter.promises.getUser(userId, splitTestName))
  if (user) {
    const assignedSplitTests = user.splitTests || []
    const assignmentLog = assignedSplitTests[splitTestName] || []
    const existingAssignment = _.find(assignmentLog, { versionNumber })
    if (!existingAssignment) {
      await UserUpdater.promises.updateUser(userId, {
        $addToSet: {
          [`splitTests.${splitTestName}`]: persistedAssignment,
        },
      })
    }
  }
}

function _makeAssignment(splitTest, variant, currentVersion) {
  return {
    variant,
    analytics: {
      segmentation: splitTest
        ? {
            splitTest: splitTest.name,
            variant,
            phase: currentVersion.phase,
            versionNumber: currentVersion.versionNumber,
          }
        : {},
    },
  }
}

async function _loadSplitTestInfoInLocals(locals, splitTestName, session) {
  const splitTest = await _getSplitTest(splitTestName)
  if (splitTest) {
    const override = session?.splitTestOverrides?.[splitTestName]

    const currentVersion = SplitTestUtils.getCurrentVersion(splitTest)
    if (!currentVersion.active && !Settings.splitTest.devToolbar.enabled) {
      return
    }

    const phase = currentVersion.phase
    const info = {
      phase,
      badgeInfo: splitTest.badgeInfo?.[phase],
    }
    if (Settings.splitTest.devToolbar.enabled) {
      info.active = currentVersion.active
      info.variants = currentVersion.variants.map(variant => ({
        name: variant.name,
        rolloutPercent: variant.rolloutPercent,
      }))
      info.hasOverride = !!override
    }
    LocalsHelper.setSplitTestInfo(locals, splitTestName, info)
  } else if (Settings.splitTest.devToolbar.enabled) {
    LocalsHelper.setSplitTestInfo(locals, splitTestName, {
      missing: true,
    })
  }
}

function _getNonSaasAssignment(splitTestName) {
  if (Settings.splitTestOverrides?.[splitTestName]) {
    return {
      variant: Settings.splitTestOverrides?.[splitTestName],
      analytics: {
        segmentation: {},
      },
    }
  }
  return DEFAULT_ASSIGNMENT
}

async function _getSplitTest(name) {
  const splitTests = await SplitTestCache.get('')
  return splitTests?.get(name)
}

module.exports = {
  getAssignment: callbackify(getAssignment),
  getAssignmentForMongoUser: callbackify(getAssignmentForMongoUser),
  getAssignmentForUser: callbackify(getAssignmentForUser),
  getActiveAssignmentsForUser: callbackify(getActiveAssignmentsForUser),
  setOverrideInSession,
  clearOverridesInSession,
  promises: {
    getAssignment,
    getAssignmentForMongoUser,
    getAssignmentForUser,
    getActiveAssignmentsForUser,
  },
}
