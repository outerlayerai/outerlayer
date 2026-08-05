// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { SettingsShell, SettingsSection } from '..';

describe('SettingsSection', () => {
  it('renders title, description, and content with no footer strip when footer is omitted', () => {
    render(
      <SettingsSection title="General" description="Org details">
        <div>fields</div>
      </SettingsSection>,
    );
    expect(screen.getByText('General')).toBeInTheDocument();
    expect(screen.getByText('Org details')).toBeInTheDocument();
    expect(screen.getByText('fields')).toBeInTheDocument();
    // Read-only card: no neutral action bar.
    expect(screen.queryByTestId('settings-section-footer')).toBeNull();
  });

  it('renders the footer bar with caption left and action right when footer is given', () => {
    render(
      <SettingsSection
        title="General"
        footer={{
          caption: 'Saved automatically',
          action: <button type="button">Save</button>,
        }}
      >
        <div>fields</div>
      </SettingsSection>,
    );
    const footer = screen.getByTestId('settings-section-footer');
    expect(footer).toBeInTheDocument();
    // Both slots live inside the strip.
    expect(footer).toHaveTextContent('Saved automatically');
    expect(footer.querySelector('button')).toHaveTextContent('Save');
  });

  it('renders no heading element when title is omitted, but keeps the description', () => {
    render(
      <SettingsSection description="Org details">
        <div>fields</div>
      </SettingsSection>,
    );
    // No h6 title block — single-card tabs rely on the shell heading instead.
    expect(screen.queryByRole('heading')).toBeNull();
    expect(screen.getByText('Org details')).toBeInTheDocument();
    expect(screen.getByText('fields')).toBeInTheDocument();
  });

  it('a single-card tab shows exactly one heading — the shell heading, not a card title', () => {
    render(
      <SettingsShell heading="Organization settings" nav={<div />}>
        <SettingsSection description="Your org details">
          <div>fields</div>
        </SettingsSection>
      </SettingsShell>,
    );
    const headings = screen.getAllByRole('heading');
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent('Organization settings');
    expect(headings[0]!.tagName).toBe('H4');
  });

  it('renders a footer with only an action (no caption slot)', () => {
    render(
      <SettingsSection title="General" footer={{ action: <button type="button">Save</button> }}>
        <div>fields</div>
      </SettingsSection>,
    );
    const footer = screen.getByTestId('settings-section-footer');
    expect(footer.querySelector('button')).toHaveTextContent('Save');
    expect(footer).not.toHaveTextContent('Saved automatically');
  });
});

describe('SettingsShell', () => {
  it('renders the heading, description, nav slot, and children', () => {
    render(
      <SettingsShell
        heading="Organization settings"
        description="Manage your org"
        nav={<nav aria-label="settings nav">nav-here</nav>}
      >
        <div>pane-content</div>
      </SettingsShell>,
    );
    const heading = screen.getByText('Organization settings');
    expect(heading.tagName).toBe('H4');
    expect(screen.getByText('Manage your org')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'settings nav' })).toBeInTheDocument();
    expect(screen.getByText('pane-content')).toBeInTheDocument();
  });

  it('omits the description line when none is given', () => {
    render(
      <SettingsShell heading="App settings" nav={<div />}>
        <div>x</div>
      </SettingsShell>,
    );
    expect(screen.getByText('App settings')).toBeInTheDocument();
    // Only the heading text node exists; no stray secondary line.
    expect(screen.queryByText('Manage your org')).toBeNull();
  });
});
