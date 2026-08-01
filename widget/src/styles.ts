export interface WidgetTheme {
  primaryColor: string;
  textColor: string;
  bgColor: string;
  borderColor: string;
  errorColor: string;
  successColor: string;
}

export const defaultTheme: WidgetTheme = {
  primaryColor: '#6366f1',
  textColor: '#1f2937',
  bgColor: '#ffffff',
  borderColor: '#e5e7eb',
  errorColor: '#ef4444',
  successColor: '#10b981',
};

export function getStyles(theme: WidgetTheme): string {
  return `
    :host {
      all: initial;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
      line-height: 1.5;
      color: ${theme.textColor};
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    .pinpoint-trigger {
      position: fixed;
      z-index: 2147483647;
      width: 48px;
      height: 48px;
      border-radius: 50%;
      border: none;
      background: ${theme.primaryColor};
      color: #fff;
      cursor: pointer;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      display: flex;
      align-items: center;
      justify-content: center;
      transition: transform 0.2s ease, box-shadow 0.2s ease;
    }

    .pinpoint-trigger:hover {
      transform: scale(1.1);
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.2);
    }

    .pinpoint-trigger:focus-visible {
      outline: 2px solid ${theme.primaryColor};
      outline-offset: 2px;
    }

    .pinpoint-trigger svg {
      width: 22px;
      height: 22px;
      fill: currentColor;
    }

    .position-bottom-right {
      bottom: 20px;
      right: 20px;
    }

    .position-bottom-left {
      bottom: 20px;
      left: 20px;
    }

    .position-top-right {
      top: 20px;
      right: 20px;
    }

    .position-top-left {
      top: 20px;
      left: 20px;
    }

    .pinpoint-overlay {
      position: fixed;
      z-index: 2147483646;
      inset: 0;
      background: rgba(0, 0, 0, 0.3);
      display: flex;
      align-items: center;
      justify-content: center;
      animation: fadeIn 0.2s ease;
    }

    .pinpoint-modal {
      background: ${theme.bgColor};
      border-radius: 12px;
      padding: 24px;
      width: 90%;
      max-width: 400px;
      max-height: 90vh;
      overflow-y: auto;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.2);
      animation: slideUp 0.2s ease;
    }

    .pinpoint-modal h2 {
      font-size: 18px;
      font-weight: 600;
      margin-bottom: 16px;
      color: ${theme.textColor};
    }

    .pinpoint-form-group {
      margin-bottom: 14px;
    }

    .pinpoint-form-group label {
      display: block;
      font-size: 13px;
      font-weight: 500;
      margin-bottom: 4px;
      color: ${theme.textColor};
    }

    .pinpoint-form-group label .optional {
      color: #9ca3af;
      font-weight: 400;
    }

    .pinpoint-form-group textarea,
    .pinpoint-form-group input,
    .pinpoint-form-group select {
      width: 100%;
      padding: 8px 12px;
      border: 1px solid ${theme.borderColor};
      border-radius: 8px;
      font-size: 14px;
      font-family: inherit;
      color: ${theme.textColor};
      background: ${theme.bgColor};
      transition: border-color 0.15s ease;
    }

    .pinpoint-form-group textarea:focus,
    .pinpoint-form-group input:focus,
    .pinpoint-form-group select:focus {
      outline: none;
      border-color: ${theme.primaryColor};
      box-shadow: 0 0 0 3px ${theme.primaryColor}22;
    }

    .pinpoint-form-group textarea {
      resize: vertical;
      min-height: 80px;
    }

    .pinpoint-actions {
      display: flex;
      gap: 8px;
      margin-top: 16px;
    }

    .pinpoint-btn {
      flex: 1;
      padding: 10px 16px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      border: none;
      transition: opacity 0.15s ease;
    }

    .pinpoint-btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    .pinpoint-btn-primary {
      background: ${theme.primaryColor};
      color: #fff;
    }

    .pinpoint-btn-primary:hover:not(:disabled) {
      opacity: 0.9;
    }

    .pinpoint-btn-secondary {
      background: transparent;
      color: ${theme.textColor};
      border: 1px solid ${theme.borderColor};
    }

    .pinpoint-btn-secondary:hover:not(:disabled) {
      background: #f9fafb;
    }

    .pinpoint-message {
      text-align: center;
      padding: 24px 16px;
    }

    .pinpoint-message.success {
      color: ${theme.successColor};
    }

    .pinpoint-message.error {
      color: ${theme.errorColor};
    }

    .pinpoint-message p {
      font-size: 15px;
      font-weight: 500;
      margin-bottom: 4px;
    }

    .pinpoint-message small {
      font-size: 13px;
      color: #6b7280;
    }

    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    @keyframes slideUp {
      from { transform: translateY(10px); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }
  `;
}
