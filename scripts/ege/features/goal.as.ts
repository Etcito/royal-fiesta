// Goal (feature kind goal, rank 15) is a stateless kind with no system. Its factory has empty
// preStep and postStep bodies (packages/sim/src/features/football.ts:243-273), so the schema has no
// rf.feature.goal.pre or rf.feature.goal.post entry. Its feature_goal records are read by the ball
// post system, which scores when the ball centre is inside a goal box. This module exports nothing.
