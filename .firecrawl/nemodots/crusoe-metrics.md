[Skip to main content](https://docs.crusoecloud.com/serverless-inference/inference-metrics/#__docusaurus_skipToContent_fallback)

Use $5 in free credits to explore [Serverless Inference](https://console.crusoecloud.com/foundry/serverless-deployments) and [Serverless Fine-Tuning](https://console.crusoecloud.com/foundry/fine-tuning/jobs)

Copy page

On this page

Serverless Inference records metrics for every model it serves, with no configuration required. The metrics update every minute and are available on the [metrics](https://console.crusoecloud.com/foundry/metrics) page. You can also integrate them with Grafana dashboards through a Prometheus-compatible query API. To query that API yourself, see [Retrieve metrics using the PromQL API](https://docs.crusoecloud.com/serverless-inference/inference-metrics/#retrieve-metrics-using-the-promql-api).

## Available metrics [​](https://docs.crusoecloud.com/serverless-inference/inference-metrics/\#available-metrics "Direct link to Available metrics")

The following queries return the same series that back the charts on the console metrics page. Replace `{project_id}` with your project ID and `{model_alias}` with the model name you pass in your API requests.

### Requests [​](https://docs.crusoecloud.com/serverless-inference/inference-metrics/\#requests "Direct link to Requests")

`inference_counter_chat_request` counts only successfully served requests. Use `inference_counter_all_chat_request` to include error and rate-limited responses.

| **Metric** | **Definition** | **Metric query** |
| --- | --- | --- |
| Request rate | Successful requests per second | `sum by (model_alias) ( rate( inference_counter_chat_request{project_id="{project_id}", model_alias="{model_alias}"}[5m] ) )` |
| Requests by status code | All requests, including client errors, rate limits (429), and server errors, split by HTTP status | `sum by (model_alias, status_code) ( rate( inference_counter_all_chat_request{project_id="{project_id}", model_alias="{model_alias}"}[5m] ) )` |
| Total requests | Cumulative count of all requests over the query window | `sum by (model_alias) ( increase( inference_counter_all_chat_request{project_id="{project_id}", model_alias="{model_alias}"}[24h] ) )` |

### Tokens [​](https://docs.crusoecloud.com/serverless-inference/inference-metrics/\#tokens "Direct link to Tokens")

These queries cover input and output token throughput, prefix cache effectiveness, and cumulative totals over a window.

| **Metric** | **Definition** | **Metric query** |
| --- | --- | --- |
| Input token rate | Input (prompt) tokens processed per second | `sum by (model_alias) ( rate( inference_counter_prompt_token{project_id="{project_id}", model_alias="{model_alias}"}[5m] ) )` |
| Output token rate | Output (completion) tokens generated per second | `sum by (model_alias) ( rate( inference_counter_output_token{project_id="{project_id}", model_alias="{model_alias}"}[5m] ) )` |
| Cached input tokens | Input tokens served from the prefix cache, per second | `sum by (model_alias) ( rate( inference_counter_cached_prompt_token{project_id="{project_id}", model_alias="{model_alias}"}[5m] ) )` |
| Prefix cache hit rate | Cached input tokens as a percentage of all input tokens | `( sum by (model_alias) ( rate( inference_counter_cached_prompt_token{project_id="{project_id}", model_alias="{model_alias}"}[5m] ) ) / sum by (model_alias) ( rate( inference_counter_prompt_token{project_id="{project_id}", model_alias="{model_alias}"}[5m] ) ) ) * 100` |
| Tokens per minute (TPM) | Total tokens (input plus output) processed per minute | `( sum by (model_alias) ( rate( inference_counter_prompt_token{project_id="{project_id}", model_alias="{model_alias}"}[5m] ) ) + sum by (model_alias) ( rate( inference_counter_output_token{project_id="{project_id}", model_alias="{model_alias}"}[5m] ) ) ) * 60` |
| Total input tokens | Cumulative input tokens over the query window | `sum by (model_alias) ( increase( inference_counter_prompt_token{project_id="{project_id}", model_alias="{model_alias}"}[24h] ) )` |
| Total output tokens | Cumulative output tokens over the query window | `sum by (model_alias) ( increase( inference_counter_output_token{project_id="{project_id}", model_alias="{model_alias}"}[24h] ) )` |

### Latency [​](https://docs.crusoecloud.com/serverless-inference/inference-metrics/\#latency "Direct link to Latency")

Latency histograms record values in seconds. Multiply by 1000 for milliseconds, as the console does. Each query below returns the median—substitute `0.9`, `0.95`, or `0.99` for `0.5` to get other percentiles.

Every histogram on this page, including the per-request token histograms below, also exposes `_sum` and `_count` series, so an average over a window is `sum(increase(<metric>_sum[1h])) / sum(increase(<metric>_count[1h]))`.

| **Metric** | **Definition** | **Metric query** |
| --- | --- | --- |
| Time to first token (TTFT) | Time from request receipt to the first returned token | `histogram_quantile( 0.5, sum by (model_alias, le) ( rate( inference_histogram_first_token_latency_bucket{project_id="{project_id}", model_alias="{model_alias}"}[5m] ) ) ) * 1000` |
| Time per output token (TPOT) | Time between successive output tokens | `histogram_quantile( 0.5, sum by (model_alias, le) ( rate( inference_histogram_output_token_latency_bucket{project_id="{project_id}", model_alias="{model_alias}"}[5m] ) ) ) * 1000` |
| End-to-end latency | Total request duration, from request receipt to completed response | `histogram_quantile( 0.5, sum by (model_alias, le) ( rate( inference_histogram_chat_latency_bucket{project_id="{project_id}", model_alias="{model_alias}"}[5m] ) ) ) * 1000` |

### Tokens per request [​](https://docs.crusoecloud.com/serverless-inference/inference-metrics/\#tokens-per-request "Direct link to Tokens per request")

These histograms show how large individual requests are. As with the latency histograms, substitute another quantile for `0.5` to see a different percentile.

| **Metric** | **Definition** | **Metric query** |
| --- | --- | --- |
| Input tokens per request | Distribution of input (prompt) tokens per request | `histogram_quantile( 0.5, sum by (model_alias, le) ( rate( inference_histogram_input_tokens_per_request_bucket{project_id="{project_id}", model_alias="{model_alias}"}[5m] ) ) )` |
| Output tokens per request | Distribution of output (completion) tokens per request | `histogram_quantile( 0.5, sum by (model_alias, le) ( rate( inference_histogram_output_tokens_per_request_bucket{project_id="{project_id}", model_alias="{model_alias}"}[5m] ) ) )` |

## Labels [​](https://docs.crusoecloud.com/serverless-inference/inference-metrics/\#labels "Direct link to Labels")

Use these labels to filter and group the queries above:

| **Label** | **Description** |
| --- | --- |
| `project_id` | The project billed for the request |
| `model_alias` | The model name you pass in your API request—filter on this label |
| `model_name` | The deployment serving the request: the upstream model name plus a deployment suffix, such as `google-gemma-4-31b-it-0dc46fd7`. It doesn't match `model_alias` |
| `service_tier` | The service tier that handled the request |
| `status_code` | HTTP status code of the response. Present on both request counters, but `inference_counter_chat_request` only ever reports `200`, so query `inference_counter_all_chat_request` for errors |
| `is_streaming` | Whether the request used streaming |

## Retrieve metrics using the PromQL API [​](https://docs.crusoecloud.com/serverless-inference/inference-metrics/\#retrieve-metrics-using-the-promql-api "Direct link to Retrieve metrics using the PromQL API")

Query the metrics API endpoint directly to retrieve data for a single instant or a specific time range. The API endpoint is:

```text
https://api.cloud.crusoe.ai/v1/projects/<project-id>/metrics/timeseries
```

To find your project ID, navigate to the [projects](https://console.crusoecloud.com/projects) page in the console, and copy the project ID.

### Generate a monitoring token [​](https://docs.crusoecloud.com/serverless-inference/inference-metrics/\#generate-a-monitoring-token "Direct link to Generate a monitoring token")

Querying metrics requires a monitoring token. To generate one, run the following command with the [Crusoe CLI](https://docs.crusoecloud.com/installing-the-cli):

```sh
crusoe monitoring tokens create
```

This command generates an `API-Key` that authenticates your requests to the metrics API. Store the token in a secret or key management tool, because you can't retrieve it later.

### Query metrics [​](https://docs.crusoecloud.com/serverless-inference/inference-metrics/\#query-metrics "Direct link to Query metrics")

To retrieve the most recent TTFT data point in your project, run:

```sh
curl -G https://api.cloud.crusoe.ai/v1/projects/<project-id>/metrics/timeseries \

  --data-urlencode 'query=histogram_quantile(0.5, sum by (model_alias, le) (rate(inference_histogram_first_token_latency_bucket[5m]))) * 1000' \

  -H 'Authorization: Bearer <API-Key>'
```

### Import data into Grafana [​](https://docs.crusoecloud.com/serverless-inference/inference-metrics/\#import-data-into-grafana "Direct link to Import data into Grafana")

To chart Serverless Inference metrics alongside the rest of your telemetry, add a Prometheus data source to your own Grafana instance. You need the `API-Key` from [Generate a monitoring token](https://docs.crusoecloud.com/serverless-inference/inference-metrics/#generate-a-monitoring-token).

1. Set **Prometheus server URL** to `https://api.cloud.crusoe.ai/v1/projects/<project-id>/metrics/timeseries`.

2. Under **Authentication → HTTP headers**, add the following header:





```text
Header: Authorization

Value: Bearer <API-Key>
```


- [Available metrics](https://docs.crusoecloud.com/serverless-inference/inference-metrics/#available-metrics)
  - [Requests](https://docs.crusoecloud.com/serverless-inference/inference-metrics/#requests)
  - [Tokens](https://docs.crusoecloud.com/serverless-inference/inference-metrics/#tokens)
  - [Latency](https://docs.crusoecloud.com/serverless-inference/inference-metrics/#latency)
  - [Tokens per request](https://docs.crusoecloud.com/serverless-inference/inference-metrics/#tokens-per-request)
- [Labels](https://docs.crusoecloud.com/serverless-inference/inference-metrics/#labels)
- [Retrieve metrics using the PromQL API](https://docs.crusoecloud.com/serverless-inference/inference-metrics/#retrieve-metrics-using-the-promql-api)
  - [Generate a monitoring token](https://docs.crusoecloud.com/serverless-inference/inference-metrics/#generate-a-monitoring-token)
  - [Query metrics](https://docs.crusoecloud.com/serverless-inference/inference-metrics/#query-metrics)
  - [Import data into Grafana](https://docs.crusoecloud.com/serverless-inference/inference-metrics/#import-data-into-grafana)
