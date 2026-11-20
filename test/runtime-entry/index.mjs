import { DurableObject } from 'cloudflare:workers';
import worker,{EditorialJobCore,EditorialBudgetCore} from '../../src/worker.mjs';
import {VisualAttempt} from '../../src/visual-attempt.mjs';
import {LIMITS} from '../../src/visual-limits.mjs';
export default worker;
export class EditorialJob extends DurableObject {
  constructor(ctx,env){super(ctx,env);this.core=new EditorialJobCore(ctx,env);
    // Only this offline test entry point can accelerate the clock budgets.
    if(env.TEST_SHORT_DEADLINES) this.core.visual=new VisualAttempt(ctx,env,{
      ...LIMITS,totalMs:4000,prepareMs:1500,minInferenceMs:2000,cleanupMs:500
    });}
  fetch(request){return this.core.fetch(request);}
  alarm(){return this.core.alarm();}
}
export class EditorialBudget extends DurableObject {
  constructor(ctx,env){super(ctx,env);this.core=new EditorialBudgetCore(ctx,env);}
  fetch(request){return this.core.fetch(request);}
}
