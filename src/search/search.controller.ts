import { Controller, Get, Query } from '@nestjs/common';
import { SearchService } from './search.service';

// Public read (only-GET-reads-are-unguarded rule). Returns people + tournaments
// for a single query; see SearchService for the safety filters.
@Controller('search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get()
  search(@Query('q') q?: string) {
    return this.searchService.search(q);
  }

  // Community landing feed (before any query): recent champions.
  @Get('spotlight')
  spotlight() {
    return this.searchService.spotlight();
  }
}
