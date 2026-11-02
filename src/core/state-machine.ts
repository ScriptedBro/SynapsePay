import { EscrowState } from '../types/escrow.js';

export class InvalidStateTransitionError extends Error {
  constructor(
    public readonly fromState: EscrowState,
    public readonly toState: EscrowState,
    public readonly reason?: string
  ) {
    super(`Illegal escrow transition from ${fromState} to ${toState}.${reason ? ` Reason: ${reason}` : ''}`);
    this.name = 'InvalidStateTransitionError';
  }
}

export class EscrowStateMachine {
  private static readonly VALID_TRANSITIONS: Record<EscrowState, EscrowState[]> = {
    [EscrowState.DRAFT]: [EscrowState.ESCROW_PENDING, EscrowState.VOIDED],
    [EscrowState.ESCROW_PENDING]: [EscrowState.ESCROW_LOCKED, EscrowState.VOIDED],
    [EscrowState.ESCROW_LOCKED]: [EscrowState.IN_PROGRESS, EscrowState.VOIDED],
    [EscrowState.IN_PROGRESS]: [EscrowState.ARBITRATION_PENDING, EscrowState.VOIDED],
    [EscrowState.ARBITRATION_PENDING]: [
      EscrowState.SETTLED,
      EscrowState.REMEDIATION_REQUIRED,
      EscrowState.VOIDED,
      EscrowState.DISPUTED,
    ],
    [EscrowState.REMEDIATION_REQUIRED]: [
      EscrowState.ARBITRATION_PENDING,
      EscrowState.IN_PROGRESS,
      EscrowState.VOIDED,
    ],
    [EscrowState.DISPUTED]: [EscrowState.SETTLED, EscrowState.VOIDED],
    [EscrowState.SETTLED]: [], // Terminal state
    [EscrowState.VOIDED]: [], // Terminal state
  };

  public static canTransition(from: EscrowState, to: EscrowState): boolean {
    const allowed = this.VALID_TRANSITIONS[from];
    return allowed ? allowed.includes(to) : false;
  }

  public static validateTransition(from: EscrowState, to: EscrowState, reason?: string): void {
    if (!this.canTransition(from, to)) {
      throw new InvalidStateTransitionError(from, to, reason);
    }
  }

  public static isTerminal(state: EscrowState): boolean {
    return state === EscrowState.SETTLED || state === EscrowState.VOIDED;
  }
}
