[Skip to main content](https://docs.crusoecloud.com/serverless-inference/rate-limits/#__docusaurus_skipToContent_fallback)

Use $5 in free credits to explore [Serverless Inference](https://console.crusoecloud.com/foundry/serverless-deployments) and [Serverless Fine-Tuning](https://console.crusoecloud.com/foundry/fine-tuning/jobs)

[![Crusoe cloud](https://docs.crusoecloud.com/img/crusoe-logo.svg)](https://www.crusoe.ai/)[Get started](https://docs.crusoecloud.com/) [Managed AI](https://docs.crusoecloud.com/managed-ai/overview) [Infrastructure Cloud](https://docs.crusoecloud.com/infrastructure-cloud/overview) [Usage and billing](https://docs.crusoecloud.com/usage-billing) [Identity and security](https://docs.crusoecloud.com/identity-and-security) [Developer resources](https://docs.crusoecloud.com/updates)

[API](https://docs.crusoecloud.com/serverless-inference/rate-limits/#)

- Crusoe Cloud
- [v1 (Latest)](https://docs.crusoecloud.com/api/)
- [v1alpha5](https://docs.crusoecloud.com/api/v1alpha5/)
- Managed AI
- [v1 (Latest)](https://docs.crusoecloud.com/api/managed-ai/)

Search...

- [Overview](https://docs.crusoecloud.com/managed-ai/overview)
- [Usage and billing](https://docs.crusoecloud.com/serverless-inference/usage-billing-models)

- Serverless Fine-Tuning

  - [Overview](https://docs.crusoecloud.com/serverless-fine-tuning/overview)
  - [How it works](https://docs.crusoecloud.com/serverless-fine-tuning/how-it-works)
  - [Quickstart](https://docs.crusoecloud.com/serverless-fine-tuning/quickstart)
  - [Fine-tune a model](https://docs.crusoecloud.com/serverless-fine-tuning/fine-tune-a-model)
  - [Available models](https://docs.crusoecloud.com/serverless-fine-tuning/available-models)

- Managed Inference

  - Serverless Inference

    - [Overview](https://docs.crusoecloud.com/serverless-inference/overview)
    - [Getting Started with Serverless Inference](https://docs.crusoecloud.com/quickstart/getting-started-with-serverless-inference)
    - [Serverless rate limits](https://docs.crusoecloud.com/serverless-inference/rate-limits)
    - [Available models](https://docs.crusoecloud.com/serverless-inference/available-models)
    - [Metrics](https://docs.crusoecloud.com/serverless-inference/inference-metrics)
  - Self-Serve Deployments

    - [Overview](https://docs.crusoecloud.com/self-serve-deployments/overview)
    - [Quickstart](https://docs.crusoecloud.com/self-serve-deployments/quickstart)
    - [Available models](https://docs.crusoecloud.com/self-serve-deployments/available-models)
    - [Notifications](https://docs.crusoecloud.com/managed-ai/notifications)

- [Home page](https://docs.crusoecloud.com/)
- Managed Inference
- Serverless Inference
- Serverless rate limits

Copy page

On this page

# Serverless rate limits

Serverless Inference runs models on shared, multi-tenant deployments. To keep capacity fair and latency consistent, Crusoe enforces rate limits that cap how many tokens and requests a project can send to a Serverless Inference endpoint each minute. Limits apply per project and per model, and only to traffic handled by Serverless Inference endpoints.

## How rate limits work [​](https://docs.crusoecloud.com/serverless-inference/rate-limits/\#how-rate-limits-work "Direct link to How rate limits work")

Two limits are tracked each minute:

- **Tokens Per Minute (TPM)**: The total input and output tokens your project can process for a given model in a one-minute window.
- **Requests Per Minute (RPM)**: The total requests your project can send to a given model in a one-minute window.

Each limit is enforced independently. When your project exceeds either one, the endpoint returns a `429 Too Many Requests` response.

## Default limits [​](https://docs.crusoecloud.com/serverless-inference/rate-limits/\#default-limits "Direct link to Default limits")

Your default limits depend on whether your organization has a payment method on file:

| Account status | TPM per model | RPM per model |
| --- | --- | --- |
| No payment method | 500,000 | 30 |
| Payment method added | 2,000,000 | 600 |

To automatically raise both limits to 2,000,000 TPM and 600 RPM, [add a payment method](https://console.crusoecloud.com/billing/payments). If your product needs higher limits than that before launching, [contact us](https://www.crusoe.ai/contact-sales) to discuss your expected volume.

503 Service Unavailable

A 2,000,000 TPM limit doesn't guarantee a successful response. Serverless Inference deployments are shared, so you can still receive a `503 Service Unavailable` while a model scales to meet aggregate traffic, even when you're within your limits.

## Responses when a limit is reached [​](https://docs.crusoecloud.com/serverless-inference/rate-limits/\#responses-when-a-limit-is-reached "Direct link to Responses when a limit is reached")

Serverless Inference returns different status codes depending on whether your project exceeded its limit or the shared endpoint is experiencing unusually high load:

| HTTP status | Description |
| --- | --- |
| `429 Too Many Requests` | Your project exceeded its TPM or RPM limit for the model. |
| `503 Service Unavailable` | Your request is within your limits, but the shared endpoint is experiencing unusually high load and can't accept it right now. |

Both `429` and `503` responses are transient, so you can [retry the request with exponential backoff](https://docs.crusoecloud.com/serverless-inference/rate-limits/#retry-with-exponential-backoff) rather than failing immediately. If you're consistently hitting your rate limit or seeing repeated `503`s, [contact us](https://www.crusoe.ai/contact-sales) so we can help raise your limits or advise on capacity planning.

Need higher rate limits or reserved capacity?

- [Contact us](https://www.crusoe.ai/contact-sales) for a rate limit increase. This is recommended if you expect your initial launch traffic to exceed the default limits.
- If you need predictable response rates or reserved inference capacity, use [Self-Serve Deployments](https://docs.crusoecloud.com/self-serve-deployments/overview). They run on dedicated hardware with reserved capacity, which gives you predictable performance and often better economics at scale.

## Retry with exponential backoff [​](https://docs.crusoecloud.com/serverless-inference/rate-limits/\#retry-with-exponential-backoff "Direct link to Retry with exponential backoff")

Your rate limit resets every minute, and shared-endpoint load fluctuates continuously, so retrying immediately only adds to the contention. Back off exponentially between attempts instead:

1. Wait a short initial delay (for example, 1 second) before your first retry.
2. Double the delay after each subsequent failed attempt (1s, 2s, 4s, 8s, and so on).
3. Add a small amount of random jitter to each delay so that multiple clients don't retry simultaneously.
4. Cap the delay (for example, at 30–60 seconds) and the number of retries, then surface the error if the request still hasn't succeeded.

Because TPM and RPM limits reset every minute, a request that fails with `429` will typically succeed within the next window. `503` responses usually clear even sooner, as soon as the shared endpoint scales to meet demand.

## Rate limit headers [​](https://docs.crusoecloud.com/serverless-inference/rate-limits/\#rate-limit-headers "Direct link to Rate limit headers")

Every Serverless Inference response includes headers that report your current limit and remaining allowance, so you can throttle client-side without waiting for a `429`:

| Header | Example | Description |
| --- | --- | --- |
| `x-ratelimit-limit-tokens` | `2000000` | Maximum tokens permitted before the TPM limit is exhausted. |
| `x-ratelimit-remaining-tokens` | `1700000` | Remaining tokens permitted before the TPM limit is exhausted. |
| `x-ratelimit-limit-requests` | `600` | Maximum requests permitted before the RPM limit is exhausted. |
| `x-ratelimit-remaining-requests` | `59` | Remaining requests permitted before the RPM limit is exhausted. |

## Considerations [​](https://docs.crusoecloud.com/serverless-inference/rate-limits/\#considerations "Direct link to Considerations")

Rate limits are designed to protect the shared endpoint from overload, not to limit consumption. Because of this, there might be instances where actual throughput exceeds your configured TPM limits.

## Next steps [​](https://docs.crusoecloud.com/serverless-inference/rate-limits/\#next-steps "Direct link to Next steps")

- [Get started with Serverless Inference](https://docs.crusoecloud.com/quickstart/getting-started-with-serverless-inference)
- [Browse available models](https://docs.crusoecloud.com/serverless-inference/available-models)
- [Monitor inference metrics](https://docs.crusoecloud.com/serverless-inference/inference-metrics)
- [Compare with Self-Serve Deployments](https://docs.crusoecloud.com/self-serve-deployments/overview)

**Tags:**

- [inference](https://docs.crusoecloud.com/tags/inference)
- [rate-limits](https://docs.crusoecloud.com/tags/rate-limits)
- [models](https://docs.crusoecloud.com/tags/models)

[Previous\\
\\
Getting Started with Serverless Inference](https://docs.crusoecloud.com/quickstart/getting-started-with-serverless-inference) [Next\\
\\
Available models](https://docs.crusoecloud.com/serverless-inference/available-models)

- [How rate limits work](https://docs.crusoecloud.com/serverless-inference/rate-limits/#how-rate-limits-work)
- [Default limits](https://docs.crusoecloud.com/serverless-inference/rate-limits/#default-limits)
- [Responses when a limit is reached](https://docs.crusoecloud.com/serverless-inference/rate-limits/#responses-when-a-limit-is-reached)
- [Retry with exponential backoff](https://docs.crusoecloud.com/serverless-inference/rate-limits/#retry-with-exponential-backoff)
- [Rate limit headers](https://docs.crusoecloud.com/serverless-inference/rate-limits/#rate-limit-headers)
- [Considerations](https://docs.crusoecloud.com/serverless-inference/rate-limits/#considerations)
- [Next steps](https://docs.crusoecloud.com/serverless-inference/rate-limits/#next-steps)

Resources

- [Cloud Status](https://status.crusoecloud.com/)
- [Crusoe.ai](https://crusoe.ai/)
- [Cloud Console](https://console.crusoecloud.com/)

Other

- [Support](https://support.crusoecloud.com/)
- [Trust Center](https://trust.crusoe.ai/)
- [Terms of Use](https://legal.crusoe.ai/#website-terms-of-use)
- [Privacy Notice](https://legal.crusoe.ai/#website-privacy-notice)

2026 Crusoe, Inc. All rights reserved.