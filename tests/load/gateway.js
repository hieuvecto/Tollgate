import http from 'k6/http';
import { check } from 'k6';
import { sleep } from 'k6';

export const options = {
  scenarios: { streams: { executor: 'constant-vus', vus: 5, duration: '10s' } },
  thresholds: { http_req_duration: ['p(95)<500'] },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};
export default function () {
  const headers = {
    Authorization: `Bearer ${__ENV.API_KEY}`,
    'Content-Type': 'application/json',
  };
  if (__ENV.TOKEN_DELAY_MS) headers['X-Tollgate-Token-Delay-Ms'] = __ENV.TOKEN_DELAY_MS;
  const response = http.post(
    `${__ENV.BASE_URL}/v1/chat/completions`,
    JSON.stringify({
      model: 'tg-mock',
      messages: [{ role: 'user', content: 'benchmark' }],
      stream: true,
      max_tokens: 32,
    }),
    { headers },
  );
  check(response, { 'completion succeeds': (value) => value.status === 200 });
  sleep(1);
}
