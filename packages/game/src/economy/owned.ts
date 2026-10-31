import type { InboxBadgeSource, OwnedSource } from '../flow/startScreen.ts'
import type { ZoneRoundResult } from '../net/zoneRounds.ts'
import type { EconomyPort } from './contract.ts'
import type { createEconomyStub } from './stub.ts'

export function economyOwned(port: EconomyPort): OwnedSource & InboxBadgeSource {
  return {
    async owned() { return (await port.me()).owned },
    async unread() { return (await port.me()).inboxUnread },
  }
}

export function rewardOffline(
  port: ReturnType<typeof createEconomyStub>,
  result: ZoneRoundResult,
  localSeats: readonly number[],
): void {
  for (const seat of result.qualified) {
    if (localSeats.includes(seat)) port.grant('qualify')
  }
  if (localSeats.includes(result.champion)) port.grant('win')
}
