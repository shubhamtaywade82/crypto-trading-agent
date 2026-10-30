import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DECISION_QUESTIONS,
  MTF_ALIGNMENT_QUESTION,
  PRIMARY_WEAKNESS_QUESTION,
  QUESTION_SET_VERSION,
  TRADE_DECISION_QUESTION,
  buildQuestionSet,
  setupWeaknessOptions,
  tradeDecisionOptions,
} from '../src/decision-intelligence/questions/questionRegistry.js';

// ─── The wire shape the decision endpoint expects ───

test('every registered question has a name, version and a valid question type', () => {
  for (const vq of DECISION_QUESTIONS) {
    assert.ok(vq.name.length > 0);
    assert.match(vq.version, /^\d+\.\d+\.\d+$/);
    assert.ok(vq.question.type === 'choice' || vq.question.type === 'noul');
  }
});

test('the v1 set asks exactly three questions, far below the 64-question maximum', () => {
  assert.equal(DECISION_QUESTIONS.length, 3);
  assert.deepEqual(
    DECISION_QUESTIONS.map((q) => q.name),
    ['trade_decision', 'primary_weakness', 'mtf_alignment'],
  );
});

test('choice questions enumerate every option they can be answered with', () => {
  for (const vq of [TRADE_DECISION_QUESTION, PRIMARY_WEAKNESS_QUESTION]) {
    assert.equal(vq.question.type, 'choice');
    const criteria = vq.question.criteria;
    for (const description of Object.values(criteria)) {
      assert.ok(description === null || description.length > 10, 'each option must describe itself or be described');
    }
  }
  assert.deepEqual(Object.keys(TRADE_DECISION_QUESTION.question.criteria), [...tradeDecisionOptions()]);
  assert.deepEqual(Object.keys(PRIMARY_WEAKNESS_QUESTION.question.criteria), [...setupWeaknessOptions()]);
});

test('the honesty contract is stated in the trade-decision instructions', () => {
  assert.match(TRADE_DECISION_QUESTION.question.instructions, /only the evidence supplied/i);
  assert.match(TRADE_DECISION_QUESTION.question.instructions, /do not forecast/i);
  assert.match(TRADE_DECISION_QUESTION.question.instructions, /INSUFFICIENT_DATA/);
});

// ─── buildQuestionSet ───

test('buildQuestionSet substitutes the candidate side into the trade-decision instructions', () => {
  const { questions, versions } = buildQuestionSet('LONG');
  assert.equal(questions.trade_decision!.type, 'choice');
  assert.match((questions.trade_decision as { instructions: string }).instructions, /LONG candidate/);
  assert.equal(versions.trade_decision, TRADE_DECISION_QUESTION.version);
  assert.equal(questions.mtf_alignment!.type, 'noul');
  assert.equal(versions.mtf_alignment, MTF_ALIGNMENT_QUESTION.version);
  assert.equal(Object.keys(questions).length, 3);
});

test('buildQuestionSet leaves the side out of the other questions and never mutates the registered originals', () => {
  const before = TRADE_DECISION_QUESTION.question.instructions;
  buildQuestionSet('SHORT');
  assert.equal(TRADE_DECISION_QUESTION.question.instructions, before);
  assert.doesNotMatch(PRIMARY_WEAKNESS_QUESTION.question.instructions, /\{side\}/);
});

test('the question set version is stamped and distinct from per-question versions only when it changes as a whole', () => {
  assert.match(QUESTION_SET_VERSION, /^\d+\.\d+\.\d+$/);
  for (const vq of DECISION_QUESTIONS) assert.match(vq.version, /^\d+\.\d+\.\d+$/);
});
