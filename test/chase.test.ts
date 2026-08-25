import { describe, expect, it } from 'vitest';
import { alreadyChased, chaseMessage, chaseStageFor } from '../src/chase';

describe('chaseStageFor', () => {
  it('puts each rung in its window', () => {
    expect(chaseStageFor(45)).toBeNull();
    expect(chaseStageFor(31)).toBeNull();
    expect(chaseStageFor(30)).toBe(30);
    expect(chaseStageFor(16)).toBe(30);
    expect(chaseStageFor(15)).toBe(15);
    expect(chaseStageFor(8)).toBe(15);
    expect(chaseStageFor(7)).toBe(7);
    expect(chaseStageFor(1)).toBe(7);
    expect(chaseStageFor(0)).toBe(0);
    expect(chaseStageFor(-40)).toBe(0);
  });

  it('treats a vendor with no certificate as stage 0', () => {
    expect(chaseStageFor(null)).toBe(0);
  });

  it('uses windows, not exact days, so a missed cron run still chases', () => {
    // The spec's "exactly 30 days" would skip this vendor forever.
    expect(chaseStageFor(29)).toBe(30);
    expect(chaseStageFor(12)).toBe(15);
  });
});

describe('alreadyChased', () => {
  it('does not repeat a rung', () => {
    expect(alreadyChased(30, 30)).toBe(true);
    expect(alreadyChased(15, 15)).toBe(true);
  });

  it('TC-16: running the cron twice in a day sends nothing twice', () => {
    for (const stage of [30, 15, 7, 0] as const) {
      expect(alreadyChased(stage, stage)).toBe(true);
    }
  });

  it('advances to the next rung as expiry approaches', () => {
    expect(alreadyChased(15, 30)).toBe(false);
    expect(alreadyChased(7, 15)).toBe(false);
    expect(alreadyChased(0, 7)).toBe(false);
  });

  it('chases a vendor never chased before', () => {
    expect(alreadyChased(30, null)).toBe(false);
  });

  it('does not re-chase a rung already passed', () => {
    // Renewed then lapsed again is a new certificate and resets last_chase_stage;
    // without that reset, going backwards must stay silent.
    expect(alreadyChased(30, 7)).toBe(true);
  });
});

describe('chaseMessage', () => {
  const base = {
    vendorName: 'Tri-County Plumbing',
    companyName: 'Apex Builders Group',
    expirationDate: '2026-07-15',
    uploadUrl: 'https://app.subshield.io/u/tok',
    missing: false,
  };

  it('copies the client only when it is urgent', () => {
    expect(chaseMessage({ ...base, stage: 30 }).ccClient).toBe(false);
    expect(chaseMessage({ ...base, stage: 15 }).ccClient).toBe(false);
    expect(chaseMessage({ ...base, stage: 7 }).ccClient).toBe(true);
    expect(chaseMessage({ ...base, stage: 0 }).ccClient).toBe(true);
  });

  it('escalates in tone without threatening at 30 days', () => {
    expect(chaseMessage({ ...base, stage: 30 }).subject).toMatch(/30 days/);
    expect(chaseMessage({ ...base, stage: 0 }).subject).toMatch(/expired/i);
    expect(chaseMessage({ ...base, stage: 30 }).html).not.toMatch(/cannot allow work/);
    expect(chaseMessage({ ...base, stage: 7 }).html).toMatch(/cannot allow work/);
  });

  it('asks for a first certificate rather than a renewal when none is on file', () => {
    const m = chaseMessage({ ...base, stage: 0, missing: true, expirationDate: null });
    expect(m.html).toMatch(/does not have a current certificate/);
    expect(m.html).not.toMatch(/expired/);
  });

  it('always carries the upload link', () => {
    for (const stage of [30, 15, 7, 0] as const) {
      expect(chaseMessage({ ...base, stage }).html).toContain(base.uploadUrl);
    }
  });

  it('does not print a bare null when the expiry is unknown', () => {
    const m = chaseMessage({ ...base, stage: 15, expirationDate: null });
    expect(m.html).not.toMatch(/null/);
  });
});
