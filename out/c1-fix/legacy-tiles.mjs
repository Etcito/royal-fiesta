// Reproduce the pre-4d10df7 stale tile identities without changing the working tree.
import { TileCells } from '../../packages/sim/src/features/tiles.ts';
const restore = TileCells.prototype.restore;
TileCells.prototype.restore = function (reader, ctx) {
  return restore.call(this, reader, ctx, true);
};
Error.stackTraceLimit = Infinity;
