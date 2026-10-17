[Skip to main content](https://docs.crusoecloud.com/quickstart/getting-started-with-serverless-inference/#__docusaurus_skipToContent_fallback)

Use $5 in free credits to explore [Serverless Inference](https://console.crusoecloud.com/foundry/serverless-deployments) and [Serverless Fine-Tuning](https://console.crusoecloud.com/foundry/fine-tuning/jobs)

[![Crusoe cloud](https://docs.crusoecloud.com/img/crusoe-logo.svg)](https://www.crusoe.ai/)[Get started](https://docs.crusoecloud.com/) [Managed AI](https://docs.crusoecloud.com/managed-ai/overview) [Infrastructure Cloud](https://docs.crusoecloud.com/infrastructure-cloud/overview) [Usage and billing](https://docs.crusoecloud.com/usage-billing) [Identity and security](https://docs.crusoecloud.com/identity-and-security) [Developer resources](https://docs.crusoecloud.com/updates)

[API](https://docs.crusoecloud.com/quickstart/getting-started-with-serverless-inference/#)

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
- Getting Started with Serverless Inference

Copy page

On this page

# Getting Started with Serverless Inference

Crusoe's Serverless Inference Service provides OpenAI compatible endpoints for a number of popular open source models. The models are hosted on Crusoe's inference engine with MemoryAlloy, a proprietary cluster-wide memory fabric with cache-aware routing that improves TTFT and throughput.

The instructions below provide steps to start querying models via the OpenAI SDK. All models are accessible via the `api.inference.crusoecloud.com` path.

## Retrieving your Intelligence API token [​](https://docs.crusoecloud.com/quickstart/getting-started-with-serverless-inference/\#retrieving-your-intelligence-api-token "Direct link to Retrieving your Intelligence API token")

You can retrieve your Intelligence API token via the [console](https://console.crusoecloud.com/) by following the steps below.

- UI

1. Visit the [Intelligence Foundry](https://console.crusoecloud.com/foundry/models) on the console.
2. Select **Inference** from the left nav.
3. Click **Create API Key** to generate an API key.
4. (Optional) Provide an alias and expiration date.
5. Click **Create** to view and save your API key.

## Querying Text models [​](https://docs.crusoecloud.com/quickstart/getting-started-with-serverless-inference/\#querying-text-models "Direct link to Querying Text models")

After retrieving an API key from the Intelligence Foundry, you can use the OpenAI SDK to make requests. The example below uses the `meta-llama/Llama-3.3-70B-Instruct` model.

Need higher rate limits or reserved capacity?

When interacting with a Serverless endpoint, you might receive a `429 Too Many Requests` response due to rate limits. If you need to exceed the default rate limits, you can:

- [Contact us](https://www.crusoe.ai/contact-sales) for a rate limit increase. This is recommended if you expect your initial launch traffic to exceed the default limits.
- If you need reserved inference capacity, use [Self-Serve Deployments](https://docs.crusoecloud.com/self-serve-deployments/overview).
- For default values, response codes, and rate limit headers, see [Serverless Rate Limits](https://docs.crusoecloud.com/serverless-inference/rate-limits).

```python
import os

from openai import OpenAI

CRUSOE_API_KEY = os.getenv("CRUSOE_API_KEY")

client = OpenAI(

    api_key=CRUSOE_API_KEY,

    base_url="https://api.inference.crusoecloud.com/v1",

)

completion = client.chat.completions.create(

    model="meta-llama/Llama-3.3-70B-Instruct",

    messages=[\
\
        {"role": "system", "content": "You are a helpful, concise assistant."},\
\
        {"role": "user", "content": "Who is Robinson Crusoe?"},\
\
    ],

)

print(completion.choices[0].message.content)
```

[Previous\\
\\
Overview](https://docs.crusoecloud.com/serverless-inference/overview) [Next\\
\\
Serverless rate limits](https://docs.crusoecloud.com/serverless-inference/rate-limits)

- [Retrieving your Intelligence API token](https://docs.crusoecloud.com/quickstart/getting-started-with-serverless-inference/#retrieving-your-intelligence-api-token)
- [Querying Text models](https://docs.crusoecloud.com/quickstart/getting-started-with-serverless-inference/#querying-text-models)

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