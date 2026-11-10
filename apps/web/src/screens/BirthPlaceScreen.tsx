import {
  Button,
  Card,
  FieldMessage,
  ListButton,
  PinIcon,
  SearchIcon,
  Skeleton,
  Stack,
  TextField,
  VisuallyHidden,
  type ScreenProps,
} from '@astro-soul/ui';
import { useEffect, useId, useRef, useState } from 'react';
import { fieldErrorsOf, type Api, type GeoPlace } from '../api';
import { ErrorState } from '../components/ErrorState';
import { MIN_QUERY_LENGTH, usePlaceSearch, type PlaceSearch } from '../hooks/usePlaceSearch';
import { formatRegion } from '../i18n/format';
import { ru } from '../i18n/ru';
import type { Telegram } from '../telegram';
import styles from './BirthPlaceScreen.module.css';
import { StepScreen } from './StepScreen';

const copy = ru.birthPlace;
/** `POST /geo/resolve`: `query` is at most 120 characters. */
const MAX_QUERY_LENGTH = 120;
const SKELETON_ROWS = [0, 1, 2];

const placeKey = (place: GeoPlace) => `${place.name}|${String(place.lat)}|${String(place.lon)}`;

/** One line under the field that follows the search; the empty and error states have blocks of their own. */
function statusText(search: PlaceSearch): string | undefined {
  switch (search.status) {
    case 'idle':
      return copy.minLength(MIN_QUERY_LENGTH);
    case 'loading':
      return copy.searching;
    case 'ready':
      return copy.found(search.places.length);
    default:
      return undefined;
  }
}

export interface BirthPlaceScreenProps {
  api: Pick<Api, 'resolveGeo'>;
  telegram: Pick<Telegram, 'isTelegram' | 'close'>;
  query: string;
  place: GeoPlace | null;
  /** The server's text about the chosen place, when it rejected the chart request. */
  serverError?: string;
  back?: ScreenProps['back'];
  /** A new query drops the chosen place; choosing a place puts its name in the field. */
  onChange: (query: string, place: GeoPlace | null) => void;
  onNext: () => void;
}

/**
 * Screen 4. The user never types coordinates or a time zone: both come from the
 * chosen place, and the object returned by the API goes into the chart request untouched.
 */
export function BirthPlaceScreen({ api, telegram, query, place, serverError, back, onChange, onNext }: BirthPlaceScreenProps) {
  const messageId = useId();
  const selectedId = useId();
  const input = useRef<HTMLInputElement>(null);
  const submit = useRef<HTMLButtonElement>(null);
  const failure = useRef<HTMLDivElement>(null);
  const [submitted, setSubmitted] = useState(false);
  // While a place is chosen the field shows its name; that must not trigger a new search.
  const search = usePlaceSearch(api, place === null ? query : '');
  const missing = place === null && submitted;
  // The server's own text about the query it was sent belongs at the field, like any other problem with its value.
  const queryError =
    search.status === 'error' ? fieldErrorsOf(search.error).find(({ field }) => field === 'query')?.message : undefined;
  const error = missing ? copy.choosePlace : (queryError ?? serverError);
  const showsMessage = place === null || error !== undefined;
  // Read once, when the screen opens: the field takes focus while there is no place yet,
  // and when the server's verdict on the chosen one brought the user back here.
  const focusesSearch = place === null || serverError !== undefined;

  // A failed search is reported in a block of its own, under the field.
  const failed = search.status === 'error' && queryError === undefined;
  useEffect(() => {
    // On a small screen or with the keyboard open that block is below the fold: a failure must not go unseen.
    if (failed) failure.current?.scrollIntoView({ block: 'nearest' });
  }, [failed]);

  const handleSubmit = () => {
    if (place !== null) {
      onNext();
      return;
    }
    setSubmitted(true);
    input.current?.focus();
  };

  const choose = (chosen: GeoPlace) => {
    // The tapped row is about to disappear; park focus on the button (this also hides the keyboard).
    submit.current?.focus();
    onChange(chosen.name, chosen);
  };

  return (
    <StepScreen
      step={3}
      title={copy.title}
      hint={copy.hint}
      submitLabel={copy.submit}
      back={back}
      submitRef={submit}
      focusesField={focusesSearch}
      onSubmit={handleSubmit}
    >
      <Stack gap="sm">
        <TextField
          ref={input}
          label={copy.label}
          placeholder={copy.placeholder}
          value={query}
          icon={<SearchIcon />}
          type="search"
          inputMode="search"
          enterKeyHint="search"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          maxLength={MAX_QUERY_LENGTH}
          autoFocus={focusesSearch}
          aria-invalid={error !== undefined || undefined}
          aria-describedby={showsMessage ? messageId : undefined}
          onKeyDown={(event) => {
            // The keyboard's "Search" key is not "Continue": fold the keyboard to reveal the results instead.
            if (event.key === 'Enter' && place === null) {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
          onChange={(text) => {
            // Typing again is the user acting on the error: stop repeating it.
            setSubmitted(false);
            onChange(text, null);
          }}
        />
        {showsMessage && <FieldMessage id={messageId} error={error} hint={statusText(search)} live />}
      </Stack>

      {place !== null && (
        <Card labelledBy={selectedId}>
          <Stack gap="sm">
            <VisuallyHidden>
              <span id={selectedId}>{copy.selectedLabel}</span>
            </VisuallyHidden>
            <div className={styles.selected}>
              <span className={styles.pin}>
                <PinIcon />
              </span>
              <div className={styles.selectedText}>
                <p className={styles.placeName}>{place.name}</p>
                <p className={styles.muted}>{formatRegion(place)}</p>
              </div>
            </div>
            <p className={styles.timezone}>{copy.timezone(place.tz)}</p>
            <p className={styles.muted}>{copy.timezoneNote}</p>
            <Button
              variant="ghost"
              onClick={() => {
                onChange(query, null);
                input.current?.focus();
              }}
            >
              {copy.change}
            </Button>
          </Stack>
        </Card>
      )}

      {search.status === 'loading' && (
        // Decorative: the line under the field says that the search is running.
        <div className={styles.results}>
          {SKELETON_ROWS.map((row) => (
            <Skeleton key={row} variant="block" className={styles.rowSkeleton} />
          ))}
        </div>
      )}

      {search.status === 'ready' && (
        <ul className={styles.results} aria-label={copy.resultsLabel}>
          {search.places.map((item) => (
            <li key={placeKey(item)}>
              <ListButton
                icon={<PinIcon />}
                title={item.name}
                description={`${formatRegion(item)} · ${item.tz}`}
                onClick={() => {
                  choose(item);
                }}
              />
            </li>
          ))}
        </ul>
      )}

      {search.status === 'empty' && (
        <div className={styles.empty} role="status">
          <p className={styles.placeName}>{copy.emptyTitle}</p>
          <p className={styles.muted}>{copy.emptyText}</p>
        </div>
      )}

      {failed && (
        <div ref={failure}>
          <ErrorState error={search.error} telegram={telegram} onRetry={search.retry} />
        </div>
      )}
    </StepScreen>
  );
}
