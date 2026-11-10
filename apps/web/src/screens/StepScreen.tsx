import { Button, Screen, ScreenHeading, Steps, type ScreenProps } from '@astro-soul/ui';
import { useId } from 'react';
import type { FormEvent, ReactNode, Ref } from 'react';
import { ru } from '../i18n/ru';
import styles from './StepScreen.module.css';

/** Birth date, time and place. */
export const TOTAL_STEPS = 3;

export interface StepScreenProps {
  /** 1-based position in the onboarding. */
  step: number;
  title: string;
  hint: string;
  submitLabel?: string;
  /** Called on the button and on the keyboard's Enter / Done key alike. */
  onSubmit: () => void;
  submitRef?: Ref<HTMLButtonElement>;
  /** Set when the screen focuses a field itself; otherwise the title takes focus. */
  focusesField?: boolean;
  back?: ScreenProps['back'];
  children: ReactNode;
}

/** Shared frame of the onboarding steps: progress, title, one form, one pinned action. */
export function StepScreen({
  step,
  title,
  hint,
  submitLabel = ru.common.next,
  onSubmit,
  submitRef,
  focusesField,
  back,
  children,
}: StepScreenProps) {
  const titleId = useId();
  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit();
  };

  return (
    // The form wraps the whole screen so that the pinned button is its submit button:
    // the keyboard's Enter / Done key then works without any extra wiring.
    <form className={styles.form} noValidate onSubmit={handleSubmit}>
      <Screen
        labelledBy={titleId}
        back={back}
        header={<Steps current={step} total={TOTAL_STEPS} label={ru.common.step(step, TOTAL_STEPS)} />}
        footer={
          <Button ref={submitRef} type="submit">
            {submitLabel}
          </Button>
        }
      >
        <div className={styles.content}>
          <ScreenHeading id={titleId} title={title} text={hint} focusOnMount={!focusesField} />
          {children}
        </div>
      </Screen>
    </form>
  );
}
