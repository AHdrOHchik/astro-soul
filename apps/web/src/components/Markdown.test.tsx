import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Markdown } from './Markdown';

describe('Markdown', () => {
  it('draws what a chapter is written with: paragraphs, a sub-heading, lists (also with the dash marker), bold and italics', () => {
    const { container } = render(
      <Markdown
        text={[
          'Первый абзац,\nв две строки.',
          '## Подзаголовок',
          '— первый пункт;\n— второй с **важным** словом.',
          '1. Раз.\n2. Два.',
          'Абзац с *курсивом* и одинокой * звёздочкой.',
        ].join('\n\n')}
      />,
    );

    expect(screen.getByText('Первый абзац, в две строки.').tagName).toBe('P');
    expect(screen.getByRole('heading', { level: 3, name: 'Подзаголовок' })).toBeInTheDocument();
    const [bullets, numbers] = screen.getAllByRole('list');
    expect(bullets?.tagName).toBe('UL');
    expect(bullets?.querySelectorAll('li')).toHaveLength(2);
    expect(numbers?.tagName).toBe('OL');
    expect(screen.getByText('важным').tagName).toBe('STRONG');
    expect(screen.getByText('курсивом').tagName).toBe('EM');
    expect(container.textContent).toContain('одинокой * звёздочкой');
  });

  it('turns no part of the text into HTML: tags go, their words stay as words, links and pictures leave no address behind', () => {
    const { container } = render(
      <Markdown
        text={[
          'До <b>жирного</b> и <img src="x" onerror="alert(1)"> после.',
          '<script>alert("xss")</script>',
          'Ссылка [со словами](javascript:alert(1)) и картинка ![alt](https://tracker.example/p.png).',
          '<a href="https://evil.example">клик</a> <!-- скрытое --> и 2 < 3 > 1.',
        ].join('\n\n')}
      />,
    );

    expect(container.querySelector('b, img, script, a, iframe')).toBeNull();
    expect(container.innerHTML).not.toMatch(/onerror|javascript:|tracker\.example|evil\.example|скрытое/);
    expect(container.textContent).toContain('До жирного и  после.');
    expect(container.textContent).toContain('alert("xss")');
    expect(container.textContent).toContain('Ссылка со словами и картинка .');
    // A comparison is not a tag.
    expect(container.textContent).toContain('2 < 3 > 1.');
  });
});
