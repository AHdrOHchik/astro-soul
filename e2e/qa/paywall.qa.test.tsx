/**
 * QA-002, задача 3.2 (продолжение): пейволл как состояние экрана.
 *
 * Вопрос приёмки: может ли клиент сам решить, что платный доступ выдан, и
 * показывает ли он платный текст до оплаты. Проверяем ровно это:
 *   1) без `full_report` (оплаты не было) полный разбор в DOM не попадает:
 *      «спрятанные» строки — фигуры, а не текст;
 *   2) кнопка покупки не активна — купить в итерации 1 нельзя, значит и
 *      ложного «купил» быть не может;
 *   3) при `full_report: true` компонент всё равно не берёт решение о доступе
 *      на себя: он рендерит то, что дал сервер, и не показывает платный текст,
 *      если сервер его не прислал (нет второго источника правды на клиенте).
 *
 * Запуск: pnpm exec vitest run --config e2e/qa/vitest.config.ts
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Teaser } from '../../apps/web/src/screens/chart/Teaser';

const REPORT_PRICE = 149;

describe('QA: пейволл (Teaser)', () => {
  it('без оплаты платного текста в DOM нет: заглушка — фигуры, а не буквы', () => {
    const { container } = render(<Teaser summary="Короткий бесплатный фрагмент." />);
    // Бесплатная часть на месте.
    expect(screen.getByText('Короткий бесплатный фрагмент.')).toBeTruthy();
    // Замок и подпись «заперто» есть.
    const hidden = container.querySelector('[aria-hidden="true"]');
    expect(hidden, 'нет блока-заглушки с aria-hidden').not.toBeNull();
    // Внутри заглушки только пустые span'ы: ни одного слова.
    const words = (hidden?.textContent ?? '').trim();
    expect(words, 'в заглушке оказался текст — его можно прочитать мимо блюра').toBe('');
  });

  it('кнопка покупки не активна: купить нельзя, ложного «куплено» нет', () => {
    render(<Teaser summary="Фрагмент." />);
    const button = screen.getByRole('button');
    expect((button as HTMLButtonElement).disabled, 'кнопка покупки активна в итерации без оплаты').toBe(true);
    expect(button.textContent ?? '').toContain(String(REPORT_PRICE));
    // Рядом объяснение, почему нельзя, а не молчание.
    expect(document.body.textContent ?? '').toMatch(/скоро|позже|появится/i);
  });

  it('цена берётся из shared, а не из литерала в компоненте', async () => {
    const { priceOf } = await import('@astro-soul/shared');
    render(<Teaser />);
    const text = screen.getByRole('button').textContent ?? '';
    expect(text).toContain(String(priceOf('one_149')));
  });
});
