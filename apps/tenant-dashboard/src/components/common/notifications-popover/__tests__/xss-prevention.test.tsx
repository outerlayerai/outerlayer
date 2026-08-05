// @vitest-environment jsdom
/**
 * XSS Prevention Tests for Notification Item
 *
 * These tests verify that the actual NotificationItem component
 * properly sanitizes HTML content via DOMPurify to prevent XSS attacks.
 *
 * NOTE: Tests the real component, not a mock sanitization function.
 */

import React from 'react';
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import NotificationItem from '../notification-item';
import type { Notification } from '../../../../types/notification';

// Mock supabase client (already mocked in unit-test-setup.ts but explicit here for clarity)
vi.mock('../../../../supabaseFrontendClient', () => ({
  createSupabaseFontendClient: vi.fn(() => ({
    from: vi.fn(() => ({
      update: vi.fn(() => ({
        eq: vi.fn(() => Promise.resolve({ data: null, error: null })),
      })),
    })),
  })),
}));

// Helper to create a notification with custom message
function createNotification(message: string): Notification {
  return {
    id: 'test-notification-id',
    message,
    created_at: new Date().toISOString(),
    read: false,
    tenant_id: 'test-tenant-id',
    type: 'info',
    updated_at: null,
    updated_by: null,
  };
}

describe('XSS Prevention in NotificationItem Component', () => {
  describe('Script tag sanitization', () => {
    it('should remove <script> tags from notification content', () => {
      const notification = createNotification(
        '<script>alert("xss")</script>Hello World'
      );
      render(<NotificationItem notification={notification} />);

      // The safe text should be visible
      expect(screen.getByText(/Hello World/)).toBeInTheDocument();
      // Script content should not appear anywhere in the document
      expect(document.body.innerHTML).not.toContain('<script>');
      expect(document.body.innerHTML).not.toContain('alert("xss")');
    });

    it('should remove script tags with src attribute', () => {
      const notification = createNotification(
        '<script src="https://evil.com/xss.js"></script>Safe content'
      );
      render(<NotificationItem notification={notification} />);

      expect(screen.getByText(/Safe content/)).toBeInTheDocument();
      expect(document.body.innerHTML).not.toContain('evil.com');
    });

    it('should handle uppercase SCRIPT tags', () => {
      const notification = createNotification(
        '<SCRIPT>document.cookie</SCRIPT>Normal text'
      );
      render(<NotificationItem notification={notification} />);

      expect(screen.getByText(/Normal text/)).toBeInTheDocument();
      expect(document.body.innerHTML.toLowerCase()).not.toContain('<script');
    });
  });

  describe('Event handler sanitization', () => {
    it('should strip onerror handlers from img tags', () => {
      const notification = createNotification(
        '<img src="x" onerror="alert(\'xss\')">After image'
      );
      render(<NotificationItem notification={notification} />);

      expect(screen.getByText(/After image/)).toBeInTheDocument();
      expect(document.body.innerHTML).not.toContain('onerror');
    });

    it('should strip onclick handlers from elements', () => {
      const notification = createNotification(
        '<div onclick="alert(\'xss\')">Click me</div>'
      );
      render(<NotificationItem notification={notification} />);

      expect(screen.getByText(/Click me/)).toBeInTheDocument();
      expect(document.body.innerHTML).not.toContain('onclick');
    });

    it('should strip onmouseover handlers', () => {
      const notification = createNotification(
        '<span onmouseover="alert(1)">Hover text</span>'
      );
      render(<NotificationItem notification={notification} />);

      expect(screen.getByText(/Hover text/)).toBeInTheDocument();
      expect(document.body.innerHTML).not.toContain('onmouseover');
    });

    it('should strip onload handlers', () => {
      const notification = createNotification(
        '<img src="valid.jpg" onload="alert(1)">Content'
      );
      render(<NotificationItem notification={notification} />);

      expect(document.body.innerHTML).not.toContain('onload');
    });
  });

  describe('JavaScript URL sanitization', () => {
    it('should neutralize javascript: URLs in href', () => {
      const notification = createNotification(
        '<a href="javascript:alert(1)">Click me</a>'
      );
      render(<NotificationItem notification={notification} />);

      expect(screen.getByText(/Click me/)).toBeInTheDocument();
      // DOMPurify removes or neutralizes javascript: URLs
      expect(document.body.innerHTML).not.toContain('javascript:alert');
    });
  });

  describe('Safe HTML preservation', () => {
    it('should preserve safe paragraph and strong tags', () => {
      const notification = createNotification(
        '<p>Hello <strong>World</strong></p>'
      );
      render(<NotificationItem notification={notification} />);

      expect(screen.getByText(/Hello/)).toBeInTheDocument();
      expect(screen.getByText(/World/)).toBeInTheDocument();
      expect(document.body.innerHTML).toContain('<p>');
      expect(document.body.innerHTML).toContain('<strong>');
    });

    it('should preserve safe anchor tags with https links', () => {
      const notification = createNotification(
        '<a href="https://example.com">Safe Link</a>'
      );
      render(<NotificationItem notification={notification} />);

      expect(screen.getByText(/Safe Link/)).toBeInTheDocument();
      expect(document.body.innerHTML).toContain('href="https://example.com"');
    });

    it('should preserve formatting tags like em and strong', () => {
      const notification = createNotification(
        '<em>Italic</em> and <strong>Bold</strong>'
      );
      render(<NotificationItem notification={notification} />);

      expect(screen.getByText(/Italic/)).toBeInTheDocument();
      expect(screen.getByText(/Bold/)).toBeInTheDocument();
    });
  });

  describe('Complex XSS payloads', () => {
    it('should handle nested malicious content', () => {
      const notification = createNotification(
        '<div><p>Safe<script>evil()</script></p><img src=x onerror=alert(1)></div>'
      );
      render(<NotificationItem notification={notification} />);

      expect(screen.getByText(/Safe/)).toBeInTheDocument();
      expect(document.body.innerHTML).not.toContain('<script>');
      expect(document.body.innerHTML).not.toContain('onerror');
    });

    it('should handle SVG-based XSS attempts', () => {
      const notification = createNotification(
        '<svg onload="alert(1)"><circle r="50"/></svg>After SVG'
      );
      render(<NotificationItem notification={notification} />);

      expect(screen.getByText(/After SVG/)).toBeInTheDocument();
      expect(document.body.innerHTML).not.toContain('onload');
    });
  });
});
