/*
 * Список маршрутов, которых нет в контракте и которые поэтому на экране не
 * сделаны. Это не «скоро будет», а способ сказать «здесь могла бы быть кнопка,
 * но ей некуда идти»: у экрана нет ни такой кнопки, ни данных, которые она
 * показывала бы.
 *
 * Источник — реестр `src/api/routes.ts` (список `GAPS`), который тестом
 * сверяется с `paths:` из `api.openapi.yaml`: строка на экране устаревает ровно
 * в тот момент, когда маршрут появляется в контракте, и тогда же она исчезает.
 */

import { missingRoutesFor, routeLabel, type ScreenKey } from '../api/routes';
import { ru } from '../i18n/ru';
import { Notice, Panel } from './primitives';

export interface RouteGapsProps {
  readonly screen: ScreenKey;
  readonly anchor: string;
}

export function RouteGaps({ screen, anchor }: RouteGapsProps) {
  const missing = missingRoutesFor(screen);
  if (missing.length === 0) return null;

  return (
    <Panel title={ru.routeGaps.heading} anchor={anchor}>
      <Notice>{ru.routeGaps.lead}</Notice>
      <table>
        <thead>
          <tr>
            <th>маршрут</th>
            <th>зачем он вообще мог понадобиться</th>
          </tr>
        </thead>
        <tbody>
          {missing.map((item) => (
            <tr key={`${item.method}-${item.path}`}>
              <td className="mono">{routeLabel(item)}</td>
              <td>{item.why}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}
