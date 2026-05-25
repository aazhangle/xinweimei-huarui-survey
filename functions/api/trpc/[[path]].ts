import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter, createCloudflareContext, type CloudflareEnv } from "../../../server/cloudflareRouter";

type PagesFunctionContext = {
  request: Request;
  env: CloudflareEnv;
};

export const onRequest = (context: PagesFunctionContext) => {
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req: context.request,
    router: appRouter,
    createContext: () => createCloudflareContext(context.env, context.request),
  });
};
