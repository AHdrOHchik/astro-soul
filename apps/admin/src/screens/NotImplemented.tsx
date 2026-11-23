/*
 * Экран раздела, который делать нельзя: серверных маршрутов нет.
 *
 * Это не «в разработке, загляните позже». У экрана без данных есть две
 * честные функции: сказать, чего не хватает, и не соврать про остальное.
 * Список маршрутов берётся из реестра (`src/api/routes.ts`), который тестом
 * сверяется с `api.openapi.yaml`, — то есть строка на экране устаревает ровно
 * в тот момент, когда маршрут появляется в контракте.
 */

import { missingRoutesFor, routeLabel, type ScreenKey } from '../api/routes';
import { ru } from '../i18n/ru';
import { Notice, Panel } from '../ui/primitives';

export interface NotImplementedProps {
  readonly screen: ScreenKey;
  readonly title: string;
}

export function NotImplemented({ screen, title }: NotImplementedProps) {
  const missing = missingRoutesFor(screen);

  return (
    <>
      <h1>{title}</h1>
      <p className="lead">{ru.notImplemented.lead}</p>
      <div className="grid">
        <Panel title={ru.notImplemented.heading} anchor="missing">
          <Notice>
            {ru.notImplemented.missing}
          </Notice>
          <ul className="tight mono">
            {missing.map((item) => (
              <li key={`${item.method}-${item.path}`}>{routeLabel(item)}</li>
            ))}
          </ul>
        </Panel>

        <Panel title={ru.notImplemented.whatIsNeeded} anchor="why">
          <table>
            <thead>
              <tr>
                <th>маршрут</th>
                <th>зачем</th>
              </tr>
            </thead>
            <tbody>
              {missing.map((item) => (
                <tr key={`why-${item.method}-${item.path}`}>
                  <td className="mono">{routeLabel(item)}</td>
                  <td>{item.why}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>
    </>
  );
}
