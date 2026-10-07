import React, { useEffect, useRef, useState } from 'react';
import type { RoomLanguage } from '@carrel/shared';
import { Button, PasscodeField, Select, Toggle } from './index';
import { Close } from '../icons';

export interface RoomSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  isHost: boolean;
  language: RoomLanguage;
  readonly: boolean;
  locked: boolean;
  hasPasscode: boolean;
  onSetLanguage: (lang: RoomLanguage) => void;
  onSetReadonly: (val: boolean) => void;
  onSetLocked: (val: boolean) => void;
  onSetPasscode: (pass: string) => void;
  onRemovePasscode: () => void;
  languages: RoomLanguage[];
  languageLabels: Record<RoomLanguage, string>;
}

export function RoomSettingsModal({
  isOpen,
  onClose,
  isHost,
  language,
  readonly,
  locked,
  hasPasscode,
  onSetLanguage,
  onSetReadonly,
  onSetLocked,
  onSetPasscode,
  onRemovePasscode,
  languages,
  languageLabels,
}: RoomSettingsModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const [passcodeVal, setPasscodeVal] = useState('');
  const [passcodeSuccess, setPasscodeSuccess] = useState(false);

  useEffect(() => {
    if (!isOpen) return;

    // Focus first focusable element
    const focusTimer = setTimeout(() => {
      if (!modalRef.current) return;
      const focusable = modalRef.current.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length > 0) focusable[0].focus();
    }, 50);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'Tab' && modalRef.current) {
        const focusable = Array.from(
          modalRef.current.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ),
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      clearTimeout(focusTimer);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="room-settings-title"
      data-testid="room-settings-modal"
    >
      <div className="modal-content room-settings-content" ref={modalRef}>
        <div className="modal-header">
          <h2 id="room-settings-title">Room Settings</h2>
          <button
            type="button"
            className="btn ghost sm close-modal-btn"
            onClick={onClose}
            aria-label="Close room settings"
          >
            <Close size={16} />
          </button>
        </div>

        {isHost ? (
          <div className="settings-controls" data-testid="host-settings-controls">
            <div className="setting-group">
              <Toggle
                label={locked ? 'Room locked (new joins rejected)' : 'Room unlocked'}
                checked={locked}
                onChange={() => onSetLocked(!locked)}
              />
            </div>

            <div className="setting-group">
              <Toggle
                label={readonly ? 'Read-only mode active' : 'Editable mode active'}
                checked={readonly}
                onChange={() => onSetReadonly(!readonly)}
              />
            </div>

            <div className="setting-group">
              <Select
                label="LANGUAGE"
                value={language}
                onChange={(e) => onSetLanguage(e.target.value as RoomLanguage)}
              >
                {languages.map((l) => (
                  <option key={l} value={l}>
                    {languageLabels[l] || l}
                  </option>
                ))}
              </Select>
            </div>

            <div className="setting-group passcode-management">
              <PasscodeField
                label="PASSCODE"
                value={passcodeVal}
                placeholder={hasPasscode ? 'Enter new passcode' : 'Set a passcode'}
                onChange={(e) => {
                  setPasscodeVal(e.target.value);
                  setPasscodeSuccess(false);
                }}
              />
              <div className="passcode-actions">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!passcodeVal || passcodeVal.length < 4}
                  onClick={() => {
                    if (passcodeVal.length >= 4) {
                      onSetPasscode(passcodeVal);
                      setPasscodeVal('');
                      setPasscodeSuccess(true);
                    }
                  }}
                >
                  SAVE PASSCODE
                </Button>
                {hasPasscode && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      onRemovePasscode();
                      setPasscodeSuccess(false);
                    }}
                  >
                    REMOVE PASSCODE
                  </Button>
                )}
              </div>
              {passcodeSuccess && (
                <span className="field-hint" style={{ color: 'var(--verdigris-500)' }}>
                  Passcode updated
                </span>
              )}
            </div>
          </div>
        ) : (
          <div className="settings-readonly-view" data-testid="non-host-settings-view">
            <p className="setting-info">
              <strong>Status: </strong>
              {locked ? 'Room is locked' : 'Room is open'}
            </p>
            <p className="setting-info">
              <strong>Editing: </strong>
              {readonly ? 'Read-only mode' : 'Editable'}
            </p>
            <p className="setting-info">
              <strong>Language: </strong>
              {languageLabels[language] || language}
            </p>
            <p className="setting-info">
              <strong>Protection: </strong>
              {hasPasscode ? 'Passcode protected' : 'No passcode'}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
