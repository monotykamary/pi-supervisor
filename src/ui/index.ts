/**
 * UI module exports.
 *
 * This module contains the supervisor UI components:
 * - Status widget rendering
 * - Animation handling
 * - UI state management
 */

export { toggleWidget, updateUI } from './renderer.js';
export { startLineClearAnimation, type RenderFn } from './animations.js';
export { createInitialState, WIDGET_ID, type WidgetAction, type WidgetState } from './types.js';
