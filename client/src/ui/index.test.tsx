import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Avatar, Button, PasscodeField, StatusBadge } from './index';

describe('Carrel UI primitives', () => {
  it('Button renders a typed action', () => {
    render(<Button>Open room</Button>);
    expect(screen.getByRole('button', { name: 'Open room' })).toHaveClass('primary');
  });
  it('PasscodeField toggles show and hide', () => {
    render(<PasscodeField label="PASSCODE" />);
    const input = screen.getByLabelText('PASSCODE');
    expect(input).toHaveAttribute('type', 'password');
    fireEvent.click(screen.getByRole('button', { name: 'Show passcode' }));
    expect(input).toHaveAttribute('type', 'text');
  });
  it('StatusBadge renders all five states with text labels', () => {
    for (const status of ['Typing', 'Active', 'Idle', 'Away', 'Reconnecting'] as const) {
      const { unmount } = render(<StatusBadge status={status} />);
      expect(screen.getByText(status)).toBeVisible();
      expect(screen.getByLabelText(`Status: ${status}`)).toBeVisible();
      unmount();
    }
  });
  it('Avatar renders an initial and accessible identity', () => {
    render(<Avatar name="Mae" color="#E4572E" />);
    expect(screen.getByText('M')).toBeVisible();
  });
});
