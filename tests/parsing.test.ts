import { describe, expect, it } from 'vitest';
import { parseDecision } from '../src/model-client.js';
import { extractThinking } from '../src/index.js';

describe('parseDecision', () => {
  it('parses valid continue response', () => {
    const text = JSON.stringify({
      action: 'continue',
      reasoning: 'Making good progress',
      confidence: 0.9,
    });

    const result = parseDecision(text);
    expect(result.action).toBe('continue');
    expect(result.reasoning).toBe('Making good progress');
    expect(result.confidence).toBe(0.9);
    expect(result.message).toBeUndefined();
  });

  it('parses valid steer response', () => {
    const text = JSON.stringify({
      action: 'steer',
      message: 'Focus on the tests first',
      reasoning: 'Agent is skipping tests',
      confidence: 0.95,
    });

    const result = parseDecision(text);
    expect(result.action).toBe('steer');
    expect(result.message).toBe('Focus on the tests first');
    expect(result.reasoning).toBe('Agent is skipping tests');
    expect(result.confidence).toBe(0.95);
  });

  it('parses valid done response', () => {
    const text = JSON.stringify({
      action: 'done',
      reasoning: 'Goal achieved',
      confidence: 0.99,
    });

    const result = parseDecision(text);
    expect(result.action).toBe('done');
    expect(result.reasoning).toBe('Goal achieved');
    expect(result.confidence).toBe(0.99);
  });

  it('extracts JSON from markdown code block', () => {
    const json = JSON.stringify({
      action: 'steer',
      message: 'Fix the error',
      reasoning: 'Test failed',
      confidence: 0.85,
    });
    const text = '```json\n' + json + '\n```';

    const result = parseDecision(text);
    expect(result.action).toBe('steer');
    expect(result.message).toBe('Fix the error');
  });

  it('extracts JSON from plain code block', () => {
    const json = JSON.stringify({
      action: 'continue',
      reasoning: 'On track',
      confidence: 0.8,
    });
    const text = '```\n' + json + '\n```';

    const result = parseDecision(text);
    expect(result.action).toBe('continue');
  });

  it('extracts JSON from curly braces when no code block', () => {
    const text =
      'Some text before { "action": "steer", "message": "Help", "reasoning": "Test", "confidence": 0.7 } some after';

    const result = parseDecision(text);
    expect(result.action).toBe('steer');
    expect(result.message).toBe('Help');
  });

  it('returns continue on invalid JSON', () => {
    const text = 'not valid json at all';

    const result = parseDecision(text);
    expect(result.action).toBe('continue');
    expect(result.reasoning).toBe('Failed to parse supervisor JSON decision');
    expect(result.confidence).toBe(0);
  });

  it('returns continue on invalid action', () => {
    const text = JSON.stringify({
      action: 'invalid',
      reasoning: 'Something',
      confidence: 0.5,
    });

    const result = parseDecision(text);
    expect(result.action).toBe('continue');
    expect(result.reasoning).toBe('Invalid action in supervisor response');
  });

  it('handles missing fields with defaults', () => {
    const text = JSON.stringify({
      action: 'continue',
    });

    const result = parseDecision(text);
    expect(result.action).toBe('continue');
    expect(result.reasoning).toBe('');
    expect(result.confidence).toBe(0.5);
    expect(result.message).toBeUndefined();
  });

  it('trims message whitespace', () => {
    const text = JSON.stringify({
      action: 'steer',
      message: '  Message with whitespace  ',
      reasoning: 'Test',
      confidence: 0.8,
    });

    const result = parseDecision(text);
    expect(result.message).toBe('Message with whitespace');
  });

  it('handles escaped quotes in reasoning', () => {
    const text = JSON.stringify({
      action: 'steer',
      message: 'Say "hello"',
      reasoning: 'The agent said "test"',
      confidence: 0.9,
    });

    const result = parseDecision(text);
    expect(result.message).toBe('Say "hello"');
    expect(result.reasoning).toBe('The agent said "test"');
  });

  it('parses ASI from steer response', () => {
    const text = JSON.stringify({
      action: 'steer',
      message: 'Focus on tests',
      reasoning: 'Agent drifting',
      confidence: 0.9,
      asi: {
        why_stuck: 'refactoring without tests',
        strategy_used: 'directive',
        pattern_detected: 'test_skipping',
        confidence_source: 'no test files added',
        would_escalate_sooner: false,
        custom_key: 'custom_value',
      },
    });

    const result = parseDecision(text);
    expect(result.asi).toBeDefined();
    expect(result.asi!.why_stuck).toBe('refactoring without tests');
    expect(result.asi!.strategy_used).toBe('directive');
    expect(result.asi!.pattern_detected).toBe('test_skipping');
    expect(result.asi!.would_escalate_sooner).toBe(false);
    expect(result.asi!.custom_key).toBe('custom_value');
  });

  it('handles missing ASI gracefully', () => {
    const text = JSON.stringify({
      action: 'steer',
      message: 'Focus',
      reasoning: 'Test',
      confidence: 0.8,
    });

    const result = parseDecision(text);
    expect(result.asi).toBeUndefined();
  });

  it('handles ASI with only partial fields', () => {
    const text = JSON.stringify({
      action: 'done',
      reasoning: 'Complete',
      confidence: 0.99,
      asi: {
        why_stuck: 'already done',
      },
    });

    const result = parseDecision(text);
    expect(result.asi).toBeDefined();
    expect(result.asi!.why_stuck).toBe('already done');
    expect(result.asi!.strategy_used).toBeUndefined();
  });
});

describe('extractThinking', () => {
  it('returns empty string when no reasoning key', () => {
    const text = '{ "action": "continue" }';
    expect(extractThinking(text)).toBe('');
  });

  it('extracts reasoning from complete JSON', () => {
    const text = JSON.stringify({
      action: 'steer',
      message: 'Focus',
      reasoning: 'The agent is drifting from the goal',
      confidence: 0.9,
    });

    expect(extractThinking(text)).toBe('The agent is drifting from the goal');
  });

  it('extracts reasoning from streaming partial JSON (no closing quote)', () => {
    const text = '{ "action": "steer", "reasoning": "The agent is working on';

    expect(extractThinking(text)).toBe('The agent is working on');
  });

  it('extracts reasoning with spaces around colon', () => {
    const text = '{ "reasoning" : "Test reasoning" }';

    expect(extractThinking(text)).toBe('Test reasoning');
  });

  it('returns empty string for malformed reasoning key', () => {
    const text = '{ "reasoning": 123 }'; // Not a string

    expect(extractThinking(text)).toBe('');
  });

  it('handles escaped newlines in reasoning', () => {
    const text = JSON.stringify({
      reasoning: 'Line 1\nLine 2',
    });

    expect(extractThinking(text)).toBe('Line 1 Line 2');
  });

  it('handles escaped quotes in reasoning', () => {
    const text = '{ "reasoning": "The agent said \\"test\\" here" }';

    expect(extractThinking(text)).toBe('The agent said "test" here');
  });

  it('extracts reasoning that appears later in the JSON', () => {
    const text =
      '{ "action": "steer", "confidence": 0.9, "reasoning": "Late reasoning", "message": "Hi" }';

    expect(extractThinking(text)).toBe('Late reasoning');
  });

  it('returns empty string for empty input', () => {
    expect(extractThinking('')).toBe('');
  });
});
