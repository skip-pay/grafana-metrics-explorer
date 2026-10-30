import { TagFilter } from '../model/types';
import {
  filterToText,
  filtersToMatchers,
  parseFilterText,
  parseScopeText,
  promString,
  renderScope,
  splitTopLevel,
} from './filters';

const eq = (key: string, value: string): TagFilter => ({ key, op: 'eq', values: [value] });
const neq = (key: string, value: string): TagFilter => ({ key, op: 'neq', values: [value] });

describe('filtersToMatchers', () => {
  it('compiles each chip kind', () => {
    expect(filtersToMatchers([eq('environment', 'prod')])).toEqual(['environment="prod"']);
    expect(filtersToMatchers([neq('path', '/health')])).toEqual(['path!="/health"']);
    expect(filtersToMatchers([eq('service', 'api*')])).toEqual(['service=~"(?:api.*)"']);
    expect(filtersToMatchers([eq('service', '*')])).toEqual(['service=~"(?:.+)"']);
    expect(filtersToMatchers([neq('path', '/v1/*/x')])).toEqual(['path!~"(?:/v1/.*/x)"']);
    expect(filtersToMatchers([{ key: 'env', op: 'in', values: ['prod', 'staging'] }])).toEqual([
      'env=~"(?:prod|staging)"',
    ]);
    expect(filtersToMatchers([{ key: 'env', op: 'not_in', values: ['prod', 'staging'] }])).toEqual([
      'env!~"(?:prod|staging)"',
    ]);
  });

  it('ORs eq chips of one key at the position of the first one', () => {
    expect(filtersToMatchers([eq('env', 'prod'), neq('path', '/x'), eq('env', 'stag*'), eq('method', 'GET')])).toEqual([
      'env=~"(?:prod|stag.*)"',
      'path!="/x"',
      'method="GET"',
    ]);
  });

  it('keeps several negations of one key as separate matchers', () => {
    expect(filtersToMatchers([neq('path', '/a'), neq('path', '/b')])).toEqual(['path!="/a"', 'path!="/b"']);
  });

  it('escapes regex metacharacters and string quotes', () => {
    expect(filtersToMatchers([eq('q', 'a.b*')])).toEqual(['q=~"(?:a\\\\.b.*)"']);
    expect(filtersToMatchers([{ key: 'path', op: 'in', values: ['/v1/(x)', 'a|b', 'c*'] }])).toEqual([
      'path=~"(?:/v1/\\\\(x\\\\)|a\\\\|b|c\\\\*)"',
    ]);
    expect(filtersToMatchers([eq('msg', 'say "hi" \\ bye')])).toEqual(['msg="say \\"hi\\" \\\\ bye"']);
  });

  it('returns nothing for no filters', () => {
    expect(filtersToMatchers([])).toEqual([]);
  });
});

describe('promString', () => {
  it('escapes backslashes, quotes and newlines', () => {
    expect(promString('a\\b"c\nd')).toBe('"a\\\\b\\"c\\nd"');
  });
});

describe('filter text', () => {
  it.each<[TagFilter, string]>([
    [eq('environment', 'prod'), 'environment:prod'],
    [neq('path', '/health'), '!path:/health'],
    [eq('service', 'api*'), 'service:api*'],
    [eq('service', '*'), 'service:*'],
    [eq('url', 'http://x:8000'), 'url:http://x:8000'],
    [eq('path', '/v1/{id}'), 'path:"/v1/{id}"'],
    [eq('a', 'x,y'), 'a:"x,y"'],
    [eq('a', ' padded'), 'a:" padded"'],
    [eq('a', 'say "hi"'), 'a:"say \\"hi\\""'],
    [eq('a', 'x OR y'), 'a:"x OR y"'],
    [eq('a', 'café crème'), 'a:café crème'],
    [{ key: 'env', op: 'in', values: ['prod', 'staging'] }, 'env IN (prod,staging)'],
    [{ key: 'env', op: 'not_in', values: ['a(1)', 'b'] }, 'env NOT IN ("a(1)",b)'],
  ])('%j <-> %s', (filter, text) => {
    expect(filterToText(filter)).toBe(text);
    expect(parseFilterText(text)).toEqual(filter);
  });

  it('accepts loose spacing and lowercase IN', () => {
    expect(parseFilterText('  ! path : /x ')).toEqual(neq('path', '/x'));
    expect(parseFilterText('env in ( prod , staging )')).toEqual({ key: 'env', op: 'in', values: ['prod', 'staging'] });
    expect(parseFilterText('env not in (prod)')).toEqual({ key: 'env', op: 'not_in', values: ['prod'] });
  });

  it.each([
    ['', 'Empty filter'],
    ['environment', 'Expected key:value'],
    ['bad-key:x', 'Invalid tag key'],
    ['env:', 'Missing value'],
    ['!env:*', 'not supported'],
    ['env:"open', 'Unterminated quote'],
    ['env:"a"b', 'Unexpected text after the quoted value'],
    ['env IN (a,,b)', 'Empty value'],
  ])('rejects %j', (text, message) => {
    const result = parseFilterText(text);
    expect('error' in result && result.error).toContain(message);
  });
});

describe('scope text', () => {
  it('renders and parses the everywhere scope', () => {
    expect(renderScope([])).toBe('*');
    expect(parseScopeText('*')).toEqual([]);
    expect(parseScopeText(' ')).toEqual([]);
  });

  it('splits at top-level commas only', () => {
    expect(splitTopLevel('a:1,b IN (x,y),c:"p,q"')).toEqual(['a:1', 'b IN (x,y)', 'c:"p,q"']);
    expect(parseScopeText('a:1, !b:2,c IN (x,y)')).toEqual([
      eq('a', '1'),
      neq('b', '2'),
      { key: 'c', op: 'in', values: ['x', 'y'] },
    ]);
  });

  it('rejects boolean scopes and template variables', () => {
    expect(parseScopeText('env:prod AND host:a')).toEqual({ error: expect.stringContaining('Boolean scopes') });
    expect(parseScopeText('NOT env:prod')).toEqual({ error: expect.stringContaining('Boolean scopes') });
    expect(parseScopeText('$env')).toEqual({ error: 'Template variables are not supported' });
    expect(parseScopeText('msg:"a OR b"')).toEqual([eq('msg', 'a OR b')]);
  });
});
