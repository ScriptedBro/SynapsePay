import { describe, it, expect } from 'vitest';
import { EscrowStateMachine, InvalidStateTransitionError } from '../../src/core/state-machine.js';
import { EscrowState } from '../../src/types/escrow.js';

describe('EscrowStateMachine', () => {
  it('allows valid progressive lifecycle transitions', () => {
    expect(EscrowStateMachine.canTransition(EscrowState.DRAFT, EscrowState.ESCROW_PENDING)).toBe(true);
    expect(EscrowStateMachine.canTransition(EscrowState.ESCROW_PENDING, EscrowState.ESCROW_LOCKED)).toBe(true);
    expect(EscrowStateMachine.canTransition(EscrowState.ESCROW_LOCKED, EscrowState.IN_PROGRESS)).toBe(true);
    expect(EscrowStateMachine.canTransition(EscrowState.IN_PROGRESS, EscrowState.ARBITRATION_PENDING)).toBe(true);
    expect(EscrowStateMachine.canTransition(EscrowState.ARBITRATION_PENDING, EscrowState.PAYOUT_PENDING)).toBe(true);
    expect(EscrowStateMachine.canTransition(EscrowState.PAYOUT_PENDING, EscrowState.SETTLED)).toBe(true);
  });

  it('allows negotiation transitions', () => {
    expect(EscrowStateMachine.canTransition(EscrowState.DRAFT, EscrowState.NEGOTIATING)).toBe(true);
    expect(EscrowStateMachine.canTransition(EscrowState.NEGOTIATING, EscrowState.DRAFT)).toBe(true);
    expect(EscrowStateMachine.canTransition(EscrowState.NEGOTIATING, EscrowState.ESCROW_PENDING)).toBe(true);
  });

  it('allows payout failure and retry loop', () => {
    expect(EscrowStateMachine.canTransition(EscrowState.PAYOUT_PENDING, EscrowState.PAYOUT_FAILED)).toBe(true);
    expect(EscrowStateMachine.canTransition(EscrowState.PAYOUT_FAILED, EscrowState.PAYOUT_PENDING)).toBe(true);
    expect(EscrowStateMachine.canTransition(EscrowState.PAYOUT_FAILED, EscrowState.DISPUTED)).toBe(true);
  });

  it('allows remediation retry loop transitions', () => {
    expect(
      EscrowStateMachine.canTransition(EscrowState.ARBITRATION_PENDING, EscrowState.REMEDIATION_REQUIRED)
    ).toBe(true);
    expect(
      EscrowStateMachine.canTransition(EscrowState.REMEDIATION_REQUIRED, EscrowState.IN_PROGRESS)
    ).toBe(true);
  });

  it('allows cancellation/void transitions prior to settlement', () => {
    expect(EscrowStateMachine.canTransition(EscrowState.DRAFT, EscrowState.VOIDED)).toBe(true);
    expect(EscrowStateMachine.canTransition(EscrowState.ESCROW_PENDING, EscrowState.VOIDED)).toBe(true);
    expect(EscrowStateMachine.canTransition(EscrowState.ESCROW_LOCKED, EscrowState.VOIDED)).toBe(true);
    expect(EscrowStateMachine.canTransition(EscrowState.IN_PROGRESS, EscrowState.VOIDED)).toBe(true);
    expect(EscrowStateMachine.canTransition(EscrowState.ARBITRATION_PENDING, EscrowState.VOIDED)).toBe(true);
  });

  it('rejects illegal state jumps', () => {
    expect(EscrowStateMachine.canTransition(EscrowState.DRAFT, EscrowState.SETTLED)).toBe(false);
    expect(EscrowStateMachine.canTransition(EscrowState.ESCROW_PENDING, EscrowState.IN_PROGRESS)).toBe(false);
    expect(EscrowStateMachine.canTransition(EscrowState.SETTLED, EscrowState.DRAFT)).toBe(false);
    expect(EscrowStateMachine.canTransition(EscrowState.VOIDED, EscrowState.IN_PROGRESS)).toBe(false);
  });

  it('throws InvalidStateTransitionError on validateTransition failure', () => {
    expect(() => {
      EscrowStateMachine.validateTransition(EscrowState.DRAFT, EscrowState.SETTLED, 'Premature settlement');
    }).toThrow(InvalidStateTransitionError);
  });

  it('identifies terminal states correctly', () => {
    expect(EscrowStateMachine.isTerminal(EscrowState.SETTLED)).toBe(true);
    expect(EscrowStateMachine.isTerminal(EscrowState.VOIDED)).toBe(true);
    expect(EscrowStateMachine.isTerminal(EscrowState.IN_PROGRESS)).toBe(false);
    expect(EscrowStateMachine.isTerminal(EscrowState.ESCROW_LOCKED)).toBe(false);
  });
});
