'use strict';

function docReturnNextAction({ stageId, stages, deadlineExpired, state }) {
  if (stageId !== stages.email) return 'stage-not-managed';
  if (!deadlineExpired) return 'wait-deadline';
  if (!state.first) return 'reminder-1';
  if (!state.second) return 'reminder-2';
  if (!state.call) return 'move-to-call';
  return 'already-in-call-flow';
}

module.exports = { docReturnNextAction };
